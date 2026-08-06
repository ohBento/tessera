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
import { mount, unmount } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";

import App from "./App.svelte";
import {
  app,
  canGroupLayers,
  canStampLayout,
  freeCount,
  groupLayoutLayers,
  groups,
  layouts,
  moveLayersIntoGroup,
  newGroup,
  setLayoutSelection,
  stampLayout,
  toggleLayoutPick,
} from "./lib/editor.svelte";
import { addLayoutImage, assignLayout, newLayoutDoc, openLayout } from "./lib/editor.svelte";
import { emptyManifest, findLayer, groupShift } from "./lib/model";
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
  await until(() => !!app.dir && app.manifest.order.length > 0 && !app.busy);
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
  it("opens its folder without being asked and shows every tile", () => {
    expect(app.dir).toContain("FaceTexture");
    expect(app.manifest.order.length).toBeGreaterThan(0);
    expect(document.querySelector("canvas.lower-canvas")).toBeTruthy();
  });

  it("refuses to stamp a selection that is not exactly one group", async () => {
    const [a, b, c, d] = app.manifest.order;
    app.selectedTiles = [a, b];
    await newGroup();

    queuePick(await magentaSquare("s"));
    await newLayoutDoc("L");
    await addLayoutImage();
    const layoutId = openLayout()!.id;

    /* One owned tile plus one free one used to stamp the owned tile's whole
     * group and drop the free one — tiles nobody picked got a stamp, a picked
     * one got nothing, and nothing said so. */
    app.selectedTiles = [a, d];
    expect(canStampLayout()).toBe(false);
    await stampLayout(layoutId);
    expect(groups()[0].layers).toHaveLength(0);
    expect(app.error).toContain("freie und vergebene");

    // Part of a group is refused too: the rest of the group would be stamped.
    app.selectedTiles = [a];
    expect(canStampLayout()).toBe(false);

    // The whole group is fine.
    app.selectedTiles = [a, b];
    expect(canStampLayout()).toBe(true);
    await stampLayout(layoutId);
    expect(groups()[0].layers).toHaveLength(1);

    // So is a set of entirely free tiles, which makes its own group.
    app.selectedTiles = [c, d];
    expect(canStampLayout()).toBe(true);
  });

  it("makes a group from the picked tiles and counts only the free ones", async () => {
    const [a, b, c] = app.manifest.order;
    app.selectedTiles = [a, b, c];
    expect(freeCount()).toBe(3);

    await newGroup();
    expect(groups()).toHaveLength(1);
    expect(groups()[0].tiles).toEqual([a, b, c]);
    // Now claimed, so the same pick can no longer start a second group.
    expect(freeCount()).toBe(0);
  });

  it("shows a stamp under its layout's name once one is assigned", async () => {
    app.selectedTiles = [app.manifest.order[0]];
    await newGroup();

    queuePick(await magentaSquare("stempel"));
    await newLayoutDoc("Mein Layout");
    await addLayoutImage();
    await assignLayout(groups()[0].id, openLayout()!.id);

    await until(() => groups()[0].layers.length === 1);
    expect(layouts()[0].name).toBe("Mein Layout");
    await until(() => document.body.textContent!.includes("Mein Layout"));
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

  it("offers grouping only from two layers up", async () => {
    const [a] = await twoLayers();
    toggleLayoutPick(a, false);
    await new Promise((r) => setTimeout(r, 150));
    expect(canGroupLayers()).toBe(false);
  });
});
