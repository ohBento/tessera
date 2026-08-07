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
import { mount, unmount } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";

import App from "./App.svelte";
import {
  addLayoutShape,
  addLayoutText,
  app,
  applyLayoutTransform,
  canGroupLayers,
  closeLayoutDoc,
  dropLayoutLayer,
  endGesture,
  deleteLayer,
  freeCount,
  history,
  setLayerField,
  undoEdit,
  groupLayoutLayers,
  inbox,
  layouts,
  moveLayersIntoGroup,
  newProjectFrom,
  projects,
  tileLayers,
  renameLayer,
  setLayoutSelection,
  tileCaptions,
  toggleLayoutPick,
  toggleTile,
} from "./lib/editor.svelte";
import { addLayoutImage, assignTileLayout, newLayoutDoc, openLayout } from "./lib/editor.svelte";
import { emptyManifest, findLayer, groupShift, layerLabel } from "./lib/model";
import { queuePick, resetMockFiles, stashPickedFile } from "./lib/platform";

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
    b.textContent!.includes("Inbox"),
  ) as HTMLButtonElement | undefined;
  if (!card) throw new Error("no way into the inbox from the overview");
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

  it("shows a stamp under its layout's name once one is assigned", async () => {
    const a = app.folderIds[0];

    queuePick(await magentaSquare("stempel"));
    await newLayoutDoc("Mein Layout");
    await addLayoutImage();
    await assignTileLayout(a, openLayout()!.id);

    await until(() => tileLayers(a).length === 1);
    expect(layouts()[0].name).toBe("Mein Layout");
    await until(() => document.body.textContent!.includes("Mein Layout"));
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
    const section = [...document.querySelectorAll("aside button.name")].find((b) =>
      b.textContent!.includes("In the inbox"),
    ) as HTMLButtonElement;
    section.click();

    const row = () =>
      [...document.querySelectorAll("aside button.name")].find((b) =>
        b.textContent!.trim().startsWith(a),
      );
    await until(() => !!row());
    expect(row()!.textContent).toContain("1 layout(s)");
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

    /* What a cancelled rename does: Escape restores the *display label* into
     * the field and blur still fires. For an unnamed layer that label is a
     * fallback, not layer.name — writing it in gave the layer a name it never
     * had and burned an undo step on nothing. */
    await renameLayer(layer.id, layerLabel(layer));
    expect(history.past.length).toBe(steps);
    expect(findLayer(openLayout()!.layers, layer.id)!.name).toBeUndefined();

    // A real rename still lands and costs its one step.
    await renameLayer(layer.id, "Mein Text");
    expect(findLayer(openLayout()!.layers, layer.id)!.name).toBe("Mein Text");
    expect(history.past.length).toBe(steps + 1);
  });
});

describe("the Layout editor", () => {
  /** Two layers in a fresh Layout, with the canvas built. */
  async function twoLayers() {
    await newLayoutDoc("Zwei");
    for (const name of ["eins", "zwei"]) {
      queuePick(await magentaSquare(name));
      await addLayoutImage();
    }
    await until(() => (openLayout()?.layers.length ?? 0) === 2);
    return openLayout()!.layers.map((l) => l.id);
  }

  it("names a layer after the file it came from, not its content hash", async () => {
    await newLayoutDoc("Namen");
    queuePick(await magentaSquare("mein-bild"));
    await addLayoutImage();
    expect(openLayout()!.layers[0].name).toBe("mein-bild");
  });

  it("keeps a Ctrl-picked second layer selected", async () => {
    const [a, b] = await twoLayers();

    toggleLayoutPick(a, false);
    await until(() => app.layoutSelection.length === 1);

    toggleLayoutPick(b, true);
    /* The regression: the canvas answers the pick by setting its active
     * object, Fabric fires selection:created, and the handler used to reset
     * the selection to that one layer. Give those a chance to run before
     * checking, or the assertion passes on timing alone. */
    await new Promise((r) => setTimeout(r, 200));

    expect(app.layoutSelection).toHaveLength(2);
    expect(canGroupLayers()).toBe(true);
  });

  it("moves a layer into an existing group without moving it on screen", async () => {
    const [a, b] = await twoLayers();
    queuePick(await magentaSquare("drei"));
    await addLayoutImage();
    const loose = openLayout()!.layers.at(-1)!;
    loose.x = 0.5;
    loose.y = 0.8;

    setLayoutSelection([a, b]);
    await groupLayoutLayers();
    const group = openLayout()!.layers.find((l) => l.kind === "group")!;
    // Displace the group, so entering it has something to compensate for.
    group.x = 0.65;
    group.y = 0.35;
    const shift = groupShift(group);

    await moveLayersIntoGroup(group.id, [loose.id]);

    const inside = findLayer(openLayout()!.layers, loose.id)!;
    expect(inside.x + shift.dx).toBeCloseTo(0.5, 5);
    expect(inside.y + shift.dy).toBeCloseTo(0.8, 5);
    // And it really is inside now, not merely renamed.
    expect(openLayout()!.layers.some((l) => l.id === loose.id)).toBe(false);
  });

  it("puts a new group where its topmost member was, so nothing restacks", async () => {
    await newLayoutDoc("Stapel");
    for (const name of ["a", "b", "c", "d"]) {
      queuePick(await magentaSquare(name));
      await addLayoutImage();
    }
    const [a, b, c, d] = openLayout()!.layers.map((l) => l.id);

    // Group the bottom one and the third: c drew above b, and must keep to.
    setLayoutSelection([a, c]);
    await groupLayoutLayers();

    const order = openLayout()!.layers.map((l) => (l.kind === "group" ? "G" : l.id));
    expect(order).toEqual([b, "G", d]);
    const made = openLayout()!.layers[1];
    expect(made.kind === "group" ? made.children.map((x) => x.id) : null).toEqual([a, c]);
  });

  it("keeps the new group selected instead of its children", async () => {
    const [a, b] = await twoLayers();
    setLayoutSelection([a, b]);
    await groupLayoutLayers();
    // The canvas answers a group pick with its members; that must not come
    // back as the selection, or the row you just made is never the one picked.
    await new Promise((r) => setTimeout(r, 250));
    const group = openLayout()!.layers.find((l) => l.kind === "group")!;
    expect(app.layoutSelection).toEqual([group.id]);
    expect([a, b]).not.toContain(app.layoutSelection[0]);
  });

  it("moves a layer out of one group into another without moving it", async () => {
    // Four layers: two make each group, one travels between them.
    await newLayoutDoc("Umzug");
    for (const name of ["a", "b", "c", "d"]) {
      queuePick(await magentaSquare(name));
      await addLayoutImage();
    }
    const [a, b, c, d] = openLayout()!.layers.map((l) => l.id);

    setLayoutSelection([a, b]);
    await groupLayoutLayers();
    const first = openLayout()!.layers.find((l) => l.kind === "group")!;
    first.x = 0.7;

    setLayoutSelection([c, d]);
    await groupLayoutLayers();
    const second = openLayout()!.layers.filter((l) => l.kind === "group").at(-1)!;
    second.y = 0.3;

    /* A layer nested in one group, moved into another: this used to look only
     * at the top level, so nothing moved, the selection was cleared anyway and
     * an undo step was pushed for it. */
    const travelling = findLayer(openLayout()!.layers, a)!;
    const before = {
      x: travelling.x + groupShift(first).dx,
      y: travelling.y + groupShift(first).dy,
    };

    await moveLayersIntoGroup(second.id, [a]);

    const moved = findLayer(openLayout()!.layers, a)!;
    expect(moved.x + groupShift(second).dx).toBeCloseTo(before.x, 5);
    expect(moved.y + groupShift(second).dy).toBeCloseTo(before.y, 5);
    expect(first.kind === "group" && first.children.map((x) => x.id)).toEqual([b]);
    expect(second.kind === "group" && second.children.map((x) => x.id)).toEqual([c, d, a]);
  });

  it("spends one undo step on a whole run of typing", async () => {
    await newLayoutDoc("Tippen");
    await addLayoutText();
    const id = openLayout()!.layers[0].id;

    /* Busy-wait, not setTimeout: this test is about a time window, and a
     * background tab throttles timers to about a second — long enough to end
     * the very run being measured. */
    const spin = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end);
    };

    const before = history.past.length;
    for (const word of ["M", "Me", "Mei", "Mein"]) {
      await setLayerField(id, "text", word);
      spin(30);
    }
    expect(history.past.length - before).toBe(1);

    await undoEdit();
    const back = findLayer(openLayout()!.layers, id);
    expect(back?.kind === "text" && back.text).toBe("Text");
  });

  it("starts a new step once the field has been left", async () => {
    await newLayoutDoc("Pause");
    await addLayoutText();
    const id = openLayout()!.layers[0].id;

    /* This used to wait out a 700ms clock. What ends a run now is the control
     * saying so — `change` fires when a field is left or a slider released,
     * and App.svelte listens for it on the window. Dispatched here rather than
     * called directly, because the listener being wired up is half of what
     * makes the boundary real. */
    const before = history.past.length;
    await setLayerField(id, "text", "A");
    await setLayerField(id, "text", "AB");
    expect(history.past.length - before).toBe(1);

    window.dispatchEvent(new Event("change", { bubbles: true }));
    await setLayerField(id, "text", "ABC");
    expect(history.past.length - before).toBe(2);
  });

  it("drags a row to the top of the list", async () => {
    await newLayoutDoc("Ziehen");
    for (const name of ["a", "b", "c"]) {
      queuePick(await magentaSquare(name));
      await addLayoutImage();
    }
    const [a, b, c] = openLayout()!.layers.map((l) => l.id);

    /* The list shows topmost first — c, b, a — so dropping `a` above `c` means
     * landing at the end of the model's list. Getting the two directions
     * confused is invisible until something draws in the wrong order. */
    await dropLayoutLayer(a, null, null);
    expect(openLayout()!.layers.map((l) => l.id)).toEqual([b, c, a]);

    // And back down: in front of b puts it at the bottom again.
    await dropLayoutLayer(a, null, b);
    expect(openLayout()!.layers.map((l) => l.id)).toEqual([a, b, c]);
  });

  it("drags a row into a group and out again without moving it", async () => {
    const [a, b] = await twoLayers();
    queuePick(await magentaSquare("frei"));
    await addLayoutImage();
    const loose = openLayout()!.layers.at(-1)!.id;

    setLayoutSelection([a, b]);
    await groupLayoutLayers();
    const group = openLayout()!.layers.find((l) => l.kind === "group")!;
    group.x = 0.75;
    group.y = 0.25;

    const before = {
      x: findLayer(openLayout()!.layers, loose)!.x,
      y: findLayer(openLayout()!.layers, loose)!.y,
    };

    await dropLayoutLayer(loose, group.id, null);
    const inside = findLayer(openLayout()!.layers, loose)!;
    const shift = groupShift(group);
    expect(inside.x + shift.dx).toBeCloseTo(before.x, 5);
    expect(inside.y + shift.dy).toBeCloseTo(before.y, 5);

    await dropLayoutLayer(loose, null, null);
    const out = findLayer(openLayout()!.layers, loose)!;
    expect(out.x).toBeCloseTo(before.x, 5);
    expect(out.y).toBeCloseTo(before.y, 5);
    expect(openLayout()!.layers.some((l) => l.id === loose)).toBe(true);
  });

  it("refuses to drag a group into itself", async () => {
    const [a, b] = await twoLayers();
    setLayoutSelection([a, b]);
    await groupLayoutLayers();
    const group = openLayout()!.layers.find((l) => l.kind === "group")!;
    const before = history.past.length;

    await dropLayoutLayer(group.id, group.id, null);

    expect(openLayout()!.layers.map((l) => l.id)).toEqual([group.id]);
    // And a refused move costs no undo step.
    expect(history.past.length).toBe(before);
  });

  it("does not resize a caption just for being dragged", async () => {
    await newLayoutDoc("Textzug");
    await addLayoutText();
    const l = openLayout()!.layers[0];
    const size = l.kind === "text" ? l.size : 0;

    /* A caption's box is measured against its words, so its share of the tile
     * is an arbitrary number — reading the size back from it meant every plain
     * move rescaled the text, and the slider and the drag then fought over it. */
    await applyLayoutTransform(l.id, {
      x: 0.8, y: 0.2, rotation: 0, scale: 0.21, scaleH: 0.09, fx: 1, fy: 1,
    });
    const moved = findLayer(openLayout()!.layers, l.id)!;
    expect(moved.kind === "text" && moved.size).toBeCloseTo(size, 6);
    expect(moved.x).toBeCloseTo(0.8);

    // A real scale still lands.
    await applyLayoutTransform(l.id, {
      x: 0.8, y: 0.2, rotation: 0, scale: 0.42, scaleH: 0.18, fx: 2, fy: 2,
    });
    const scaled = findLayer(openLayout()!.layers, l.id)!;
    expect(scaled.kind === "text" && scaled.size).toBeCloseTo(size * 2, 6);
  });

  it("rebuilds after a scale, so the factor is not applied twice", async () => {
    await newLayoutDoc("Nachwirkung");
    await addLayoutText();
    const l = openLayout()!.layers[0];

    /* Fabric leaves the factor it applied on the object. A plain move skips the
     * rebuild on purpose — the object is already where it belongs — but a scale
     * must not, or the object keeps scaleX 1.5 and the next gesture reports 1.5
     * again: two drags after one scale left the model 3.4x bigger than the
     * picture, with nothing on screen to say so. */
    const still = app.version;
    await applyLayoutTransform(l.id, {
      x: 0.5, y: 0.5, rotation: 0, scale: 0.2, scaleH: 0.09, fx: 1, fy: 1,
    });
    expect(app.version).toBe(still);

    await applyLayoutTransform(l.id, {
      x: 0.5, y: 0.5, rotation: 0, scale: 0.3, scaleH: 0.135, fx: 1.5, fy: 1.5,
    });
    expect(app.version).toBeGreaterThan(still);
  });

  it("spends one undo step per gesture, not per burst of them", async () => {
    await newLayoutDoc("Zweimal");
    await addLayoutText();
    const l = openLayout()!.layers[0];
    const before = history.past.length;

    /* Two complete drags back to back. The run key exists so a multi-selection
     * writing back once per member costs one step — not so that two separate
     * gestures do, which made a single Ctrl+Z jump back past both. A pointer
     * release ends the run. */
    for (const x of [0.3, 0.7]) {
      await applyLayoutTransform(
        l.id,
        { x, y: 0.5, rotation: 0, scale: 0.2, scaleH: 0.09, fx: 1, fy: 1 },
        `drag:${l.id}`,
      );
      endGesture();
    }
    expect(history.past.length - before).toBe(2);
  });

  it("takes a gesture back when Escape is pressed mid-drag", async () => {
    await newLayoutDoc("EscProbe");
    await addLayoutText();
    const id = openLayout()!.layers[0].id;
    setLayoutSelection([id]);
    const live = () =>
      (window as { tesseraLayout?: fabric.Canvas }).tesseraLayout as fabric.Canvas;
    await until(() => !!live()?.getObjects().some((o) => (o as { layerId?: string }).layerId === id));

    const canvas = live();
    const obj = canvas.getObjects().find((o) => (o as { layerId?: string }).layerId === id)!;
    const xBefore = findLayer(openLayout()!.layers, id)!.x;

    /* Mid-drag: Fabric has moved the object and reported it. Alt held, so
     * snapping cannot vary what the numbers come out as. */
    canvas.setActiveObject(obj);
    obj.set({ left: (obj.left ?? 0) + 120 });
    obj.setCoords();
    canvas.fire("object:moving", {
      target: obj,
      e: new MouseEvent("mousemove", { altKey: true }),
    } as never);

    /* Esc lands on the body, as a real key does — aiming at the window itself
     * would skip the capture phase and reach App's own Escape first. */
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));

    // The release that still follows must write nothing.
    canvas.fire("object:modified", { target: obj } as never);
    canvas.fire("mouse:up", {} as never);
    await new Promise((r) => setTimeout(r, 200));

    expect(findLayer(openLayout()!.layers, id)!.x).toBe(xBefore);
    // And Esc mid-gesture means "drop the drag", never "close the document".
    expect(app.openLayoutId).not.toBe("");
  });

  it("does not resize a polygon just for being dragged", async () => {
    await newLayoutDoc("Vieleck");
    await addLayoutShape("polygon");
    const shape = openLayout()!.layers[0];
    const size = shape.kind === "shape" ? { w: shape.w, h: shape.h } : null;

    /* A regular n-gon's bounding box is smaller than the box it is inscribed
     * in, so deriving the size from the drawn object shrank it by 13% on every
     * drag. A plain move reports a scale factor of 1 and must change nothing. */
    await applyLayoutTransform(shape.id, {
      x: 0.7,
      y: 0.3,
      rotation: 0,
      scale: 0.26,
      scaleH: 0.225,
      fx: 1,
      fy: 1,
    });

    const after = findLayer(openLayout()!.layers, shape.id)!;
    expect(after.kind === "shape" && { w: after.w, h: after.h }).toEqual(size);
    expect(after.x).toBeCloseTo(0.7);

    // An actual scale still lands.
    await applyLayoutTransform(shape.id, {
      x: 0.7, y: 0.3, rotation: 0, scale: 0, scaleH: 0, fx: 2, fy: 0.5,
    });
    const scaled = findLayer(openLayout()!.layers, shape.id)!;
    expect(scaled.kind === "shape" && scaled.w).toBeCloseTo(size!.w * 2);
    expect(scaled.kind === "shape" && scaled.h).toBeCloseTo(size!.h * 0.5);
  });

  it("spends one undo step on dragging a whole multi-selection", async () => {
    const [a, b] = await twoLayers();
    const before = history.past.length;
    // What LayoutCanvas does for an ActiveSelection: one write per member,
    // under one gesture name.
    for (const id of [a, b]) {
      await applyLayoutTransform(
        id,
        { x: 0.6, y: 0.6, rotation: 0, scale: 0.3, scaleH: 0.3, fx: 1, fy: 1 },
        `drag:${a},${b}`,
      );
    }
    expect(history.past.length - before).toBe(1);
  });

  it("offers grouping only from two layers up", async () => {
    const [a] = await twoLayers();
    toggleLayoutPick(a, false);
    await new Promise((r) => setTimeout(r, 150));
    expect(canGroupLayers()).toBe(false);
  });
});
