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
  assignLayoutToSelection,
  assignLayoutToWall,
  canGroupLayers,
  closeLayoutDoc,
  dropLayoutLayer,
  duplicateLayoutLayers,
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
import { addLayoutImage, assignTileLayout, newLayoutDoc, openLayout } from "./lib/editor.svelte";
import {
  emptyManifest,
  findLayer,
  groupShift,
  isGradient,
  layerLabel,
  type ImageLayer,
  type ShapeLayer,
  type TextLayer,
} from "./lib/model";
import { maskChoices, maskOffers } from "./lib/model";
import { textWidth } from "./lib/scene";
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

  it("hiding a stamp hides the whole assignment, live layers and all", async () => {
    /* The stamp's row speaks for the copies a Layout keeps beside it — they
     * have no row of their own. Hiding it and leaving those drawn meant the
     * eye did nothing you could see: the caption and the logo stayed on the
     * wall with nothing left to switch them off. */
    const a = app.folderIds[0];
    await newLayoutDoc("Mit Text");
    await addLayoutText();
    const caption = openLayout()!.layers[0];
    await setLayerField(caption.id, "perTile", true);
    await assignTileLayout(a, openLayout()!.id);
    await until(() => tileLayers(a).length === 2);

    const stamp = tileLayers(a).find((l) => l.kind === "image")!;
    await toggleLayerHidden(stamp.id);
    expect(tileLayers(a).map((l) => !!l.hidden)).toEqual([true, true]);

    // And back, in one press.
    await toggleLayerHidden(stamp.id);
    expect(tileLayers(a).map((l) => !!l.hidden)).toEqual([false, false]);
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

  it("keeps a picture's side handles once it is selected", async () => {
    /* The handles are put on the object when the scene is built, and the
     * selection rules run again every time the picked layer changes — so a
     * rule that hides them there quietly undoes the build, and nothing below
     * this component can see it happen. That is exactly how cropping first
     * shipped with no handle to crop by: every test around it built a canvas
     * directly, and not one of them ever selected anything. */
    queuePick(await magentaSquare("zuschnitt"));
    await newLayoutDoc("Griffe");
    await addLayoutImage();
    const id = openLayout()!.layers[0].id;

    const live = () =>
      (window as { tesseraLayout?: fabric.Canvas }).tesseraLayout as fabric.Canvas;
    await until(
      () => !!live()?.getObjects().some((o) => (o as { layerId?: string }).layerId === id),
    );

    setLayoutSelection([id]);
    await until(() => !!live().getActiveObject());

    const obj = live().getActiveObject()!;
    for (const side of ["ml", "mr", "mt", "mb"] as const) {
      expect(obj.isControlVisible(side)).toBe(true);
    }
  });

  it("turns a fill into a gradient from the panel, and the canvas paints it", async () => {
    /* Gradients were in the model and in scene.ts from the start and no
     * control ever made one — the swatch read a gradient's start colour and
     * wrote a flat colour back, so the feature was unreachable from the app.
     * Driven through the real button for that reason: a test that called
     * setLayerField would have passed against the panel that had no button. */
    await newLayoutDoc("Verlauf");
    await addLayoutShape("rect");
    const shape = openLayout()!.layers[0] as ShapeLayer;
    // Read now, not after the click: mutate edits the layer in place, so the
    // same object would hand back the gradient and the check would compare the
    // colour against itself.
    const was = shape.fill;
    setLayoutSelection([shape.id]);

    const ramp = 'button.ramp[aria-label*="Fade"]';
    await until(() => !!document.querySelector(ramp));
    document.querySelector<HTMLButtonElement>(ramp)!.click();

    await until(() => isGradient((findLayer(openLayout()!.layers, shape.id) as ShapeLayer).fill));
    const fill = (findLayer(openLayout()!.layers, shape.id) as ShapeLayer).fill;
    // The colour it had is where the ramp starts: pressing this must not throw
    // the picked colour away.
    expect(isGradient(fill) && fill.from).toBe(was);

    const live = () => (window as { tesseraLayout?: fabric.Canvas }).tesseraLayout as fabric.Canvas;
    await until(() => {
      const obj = live()
        ?.getObjects()
        .find((o) => (o as { layerId?: string }).layerId === shape.id);
      return typeof obj?.fill === "object";
    });
  });

  it("numbers a new layer rather than naming it after the file", async () => {
    /* The file name was misleading the moment a Layout was involved — the same
     * picture is a frame in one and a class logo in another — and the asset it
     * would otherwise fall back to is a content hash, which says nothing at
     * all. The number is per kind and per stack. */
    await newLayoutDoc("Namen");
    queuePick(await magentaSquare("mein-bild"));
    await addLayoutImage();
    await addLayoutText();
    queuePick(await magentaSquare("noch-eins"));
    await addLayoutImage();
    await until(() => openLayout()!.layers.length === 3);
    expect(openLayout()!.layers.map((l) => l.name)).toEqual(["img01", "text01", "img02"]);
  });

  it("imports an SVG at the size its viewBox says, not the browser's 300×150", async () => {
    /* The whole reason importAsset touches SVG at all. Measured the way the app
     * measures it: an <img> on the stored bytes, which is what Fabric builds
     * behind every picture layer. Without the rewrite this reads 300×150 — the
     * CSS default object size — and the icon lands in the Layout at a scale the
     * file never asked for. */
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 16"><rect width="64" height="16"/></svg>';
    queuePick(stashPickedFile("klasse.svg", new TextEncoder().encode(svg)));
    await newLayoutDoc("Mit Icon");
    await addLayoutImage();
    await until(() => (openLayout()?.layers.length ?? 0) === 1);

    const asset = (openLayout()!.layers[0] as ImageLayer).asset;
    const url = await app.deps!.asset(asset);
    const size = await new Promise<{ w: number; h: number }>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = reject;
      img.src = url;
    });

    expect(size).toEqual({ w: 64, h: 16 });
  });

  it("deletes every picked layer in one undo step", async () => {
    /* The menu above it reads "Group 2 layers" and "Duplicate 2 layers" and
     * acts on the selection; Delete sat underneath them and removed the clicked
     * row alone, without a word about the other one. */
    const [a, b] = await twoLayers();
    setLayoutSelection([a, b]);
    const steps = history.past.length;

    await deleteLayoutLayers([a, b]);

    expect(openLayout()!.layers).toEqual([]);
    expect(history.past.length).toBe(steps + 1);
    await undoEdit();
    expect(openLayout()!.layers.map((l) => l.id)).toEqual([a, b]);
  });

  it("duplicates the picked layers above the originals", async () => {
    /* A copy that lands underneath its original looks like nothing happened,
     * and one that keeps the original's ids is the same layer twice. */
    const [a] = await twoLayers();
    setLayoutSelection([a]);
    const before = openLayout()!.layers.length;

    await duplicateLayoutLayers();

    const layers = openLayout()!.layers;
    expect(layers).toHaveLength(before + 1);
    const original = layers.find((l) => l.id === a)!;
    const copy = layers[layers.indexOf(original) + 1];
    expect(copy.id).not.toBe(a);
    // Offset, or it would be hiding under the thing it was copied from.
    expect(copy.x).toBeCloseTo(original.x + 0.02, 6);
    // Named for the stack it joined, and picked, since moving it is next.
    expect(copy.name).not.toBe(original.name);
    expect(app.layoutSelection).toEqual([copy.id]);
  });

  it("duplicates a layer that sits inside a group, into that group", async () => {
    /* The selection can name a layer nested in a group — the list wires the
     * same handlers to those rows — but the copy only ever looked at the top
     * level. It found nothing, did nothing, and still burned an undo step,
     * because the checkpoint is taken before the callback runs. */
    const [a, b] = await twoLayers();
    setLayoutSelection([a, b]);
    await groupLayoutLayers();
    const group = openLayout()!.layers.find((l) => l.kind === "group")!;
    const inside = group.kind === "group" ? group.children[0] : undefined!;

    setLayoutSelection([inside.id]);
    const steps = history.past.length;
    await duplicateLayoutLayers();

    const after = openLayout()!.layers.find((l) => l.id === group.id)!;
    expect(after.kind === "group" && after.children).toHaveLength(3);
    expect(history.past.length).toBe(steps + 1);
  });

  it("spends no undo step when there is nothing to duplicate", async () => {
    await newLayoutDoc("Nichts");
    setLayoutSelection([]);
    const steps = history.past.length;
    await duplicateLayoutLayers();
    expect(history.past.length).toBe(steps);
  });

  it("points a duplicated mask at the duplicated shape, not the original", async () => {
    await newLayoutDoc("Maske kopieren");
    await addLayoutShape("rect");
    await addLayoutText();
    const [shape, words] = openLayout()!.layers;
    await setLayerField(words.id, "maskId", shape.id);

    setLayoutSelection([shape.id, words.id]);
    await duplicateLayoutLayers();

    const copies = openLayout()!.layers.filter((l) => ![shape.id, words.id].includes(l.id));
    expect(copies).toHaveLength(2);
    const copiedText = copies.find((l) => l.kind === "text")!;
    const copiedShape = copies.find((l) => l.kind === "shape")!;
    /* Pointing back at the original would mean editing one design moved the
       other's hole — the surprise duplicating exists to avoid. */
    expect(copiedText.maskId).toBe(copiedShape.id);
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

  it("grows a left-aligned caption to the right, not out of both sides", async () => {
    /* x is the centre, so longer words used to push the caption out sideways in
     * both directions — line one of a stack would creep left while line two
     * stayed put. Left-aligned text has its anchor at the left edge, and that
     * is what stays still. */
    await newLayoutDoc("Wachstum");
    await addLayoutText();
    const l = openLayout()!.layers[0] as TextLayer;
    await setLayerField(l.id, "align", "left");
    await setLayerField(l.id, "text", "M");

    const at = () => {
      const t = findLayer(openLayout()!.layers, l.id) as TextLayer;
      return { left: t.x - textWidth(t) / 2, x: t.x };
    };
    const before = at();

    await setLayerField(l.id, "text", "MMMMMMMMMMMM");
    const after = at();
    expect(after.left).toBeCloseTo(before.left, 5);
    // It really did get wider — otherwise the assertion above proves nothing.
    expect(after.x).toBeGreaterThan(before.x);
  });

  it("leaves a centred caption centred", async () => {
    await newLayoutDoc("Mitte");
    await addLayoutText();
    const l = openLayout()!.layers[0] as TextLayer;
    await setLayerField(l.id, "align", "center");
    await setLayerField(l.id, "text", "M");
    const x = (findLayer(openLayout()!.layers, l.id) as TextLayer).x;

    await setLayerField(l.id, "text", "MMMMMMMMMMMM");
    expect((findLayer(openLayout()!.layers, l.id) as TextLayer).x).toBeCloseTo(x, 5);
  });

  it("leaves a caption's size to the properties panel, whatever the canvas says", async () => {
    /* The font size is a field now, and only a field. A caption's box is
     * measured against its words, so a handle had no honest size to report
     * anyway — dragging one multiplied the number you had just typed, and a
     * plain move used to do it too. Moving still lands; scaling does not. */
    await newLayoutDoc("Textzug");
    await addLayoutText();
    const l = openLayout()!.layers[0];
    const size = l.kind === "text" ? l.size : 0;

    await applyLayoutTransform(l.id, {
      x: 0.8, y: 0.2, rotation: 0, scale: 0.21, scaleH: 0.09, fx: 1, fy: 1,
    });
    const moved = findLayer(openLayout()!.layers, l.id)!;
    expect(moved.kind === "text" && moved.size).toBeCloseTo(size, 6);
    expect(moved.x).toBeCloseTo(0.8);

    await applyLayoutTransform(l.id, {
      x: 0.8, y: 0.2, rotation: 0, scale: 0.42, scaleH: 0.18, fx: 2, fy: 2,
    });
    const scaled = findLayer(openLayout()!.layers, l.id)!;
    expect(scaled.kind === "text" && scaled.size).toBeCloseTo(size, 6);
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

/* Not covered by a test, deliberately: the reset that used to snap the wall
 * back to Unsorted sits between "the folder was asked for" and "the load
 * finished", and against the in-memory mock that gap is shorter than the 25ms
 * this file polls at. Two attempts at pinning it both passed against the bug
 * before they passed against the fix, which is worse than no test — so the
 * proof is a measurement in the running editor instead: a wall picked while a
 * real folder was still hashing stayed open. See openFolder in editor.svelte.ts,
 * where the reset now sits directly under `app.dir`. */

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
