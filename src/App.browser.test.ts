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
  freeCount,
  groupLayoutLayers,
  groups,
  layouts,
  moveLayersIntoGroup,
  newGroup,
  setLayoutSelection,
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

  it("offers grouping only from two layers up", async () => {
    const [a] = await twoLayers();
    toggleLayoutPick(a, false);
    await new Promise((r) => setTimeout(r, 150));
    expect(canGroupLayers()).toBe(false);
  });
});
