/* What the wall costs to draw, measured rather than guessed.
 *
 * buildGrid runs on every edit — a nudged caption rebuilds the whole wall — so
 * its cost is the app's responsiveness, and it grows with the number of tiles.
 * A grid of 44 is the size the tool was built against; the numbers here exist
 * so a change that makes a wall of hundreds unusable is visible before someone
 * builds one.
 *
 * Almost nothing here is asserted, and what is, is asserted against another
 * number from the same run rather than against a stopwatch — a wall clock in
 * a test suite measures the machine's mood as much as the code. The numbers
 * themselves are the point, and they are printed:
 *
 *   npx vitest run --project browser --reporter=verbose src/lib/perf.browser.test.ts
 */
import { describe, expect, it } from "vitest";
import * as fabric from "fabric";

import { TILE_H, TILE_W } from "./bmp";
import {
  emptyManifest,
  emptyTile,
  newImageLayer,
  newProject,
  newShapeLayer,
  newTextLayer,
  type Manifest,
} from "./model";
import { buildGrid, gridSize, rebuildTile, type Wall } from "./scene";
import { testDeps } from "../test/images";

/** A wall of `count` tiles, each dressed the way a real one is: the game's own
 *  portrait underneath, a caption, and a stamp-shaped picture over it. A bare
 *  grid would measure the background loader and nothing else. */
function dressed(count: number): Manifest {
  const m = emptyManifest();
  const p = newProject("Bench");
  p.order = Array.from({ length: count }, (_, i) => `4000000000${String(i).padStart(6, "0")}`);
  m.projects = [p];
  for (const id of p.order) {
    const caption = newTextLayer();
    caption.text = id.slice(-4);
    caption.y = 0.85;
    const stamp = newImageLayer(`stamp-${id.slice(-1)}`);
    stamp.scale = 0.4;
    m.tiles[id] = { ...emptyTile(), layers: [stamp, caption] };
  }
  return m;
}

const view = (m: Manifest): Wall => ({
  ids: m.projects[0].order,
  gridLayers: m.projects[0].gridLayers,
});

/** The only absolute number asserted here, and it is a wide one on purpose.
 *
 *  The same 301-tile build measured 929ms and 1580ms on the same commit on the
 *  same machine, minutes apart — a wall clock says as much about what else is
 *  running as about the code. A ceiling set just above a good run is a test
 *  that fails for reasons its author cannot fix, and a suite that cries wolf
 *  gets muted, which costs more than the regression it was guarding against.
 *  So this one is set where a wall stops being slow and starts being broken:
 *  four seconds of frozen interface is not a measurement, it is a bug.
 *
 *  Everything worth knowing more precisely than that is measured against
 *  another number from the same run, which cancels the machine out. */
const FREEZE = 4000;

/** A canvas the size of the whole wall — what the editor holds, as opposed to
 *  the tile-sized window the export moves across it. */
function wallCanvas(count: number) {
  const size = gridSize(count);
  return new fabric.StaticCanvas(undefined, {
    width: size.w,
    height: size.h,
    enableRetinaScaling: false,
  });
}

/** Milliseconds for one buildGrid, averaged over `runs` after one warm-up.
 *
 *  The warm-up is not optional: the first build of a wall decodes every
 *  picture on it, and testDeps caches the decoded canvas exactly the way
 *  project.ts caches the real one. Measuring only cold builds would report the
 *  decoder; measuring only warm ones would hide what a first open costs. Both
 *  numbers are returned. */
async function timeBuild(count: number, runs = 3) {
  const m = dressed(count);
  const wall = view(m);
  const canvas = wallCanvas(count);
  try {
    const coldStart = performance.now();
    await buildGrid(canvas, wall, m, testDeps, true);
    const cold = performance.now() - coldStart;

    const warmStart = performance.now();
    for (let i = 0; i < runs; i++) await buildGrid(canvas, wall, m, testDeps, true);
    const warm = (performance.now() - warmStart) / runs;

    return { cold, warm, objects: canvas.getObjects().length };
  } finally {
    await canvas.dispose();
  }
}

describe("wall build cost", () => {
  /* 7 columns, so these are 7, 44 and 301 tiles' worth of rows: one row, the
   * size the tool was built against, and the size the question is about. */
  for (const count of [7, 44, 301]) {
    it(`${count} tiles`, async () => {
      const { cold, warm, objects } = await timeBuild(count);
      console.log(
        `${String(count).padStart(3)} tiles: cold ${cold.toFixed(0)}ms, ` +
          `rebuild ${warm.toFixed(0)}ms, ${objects} objects ` +
          `(${(warm / count).toFixed(2)}ms/tile)`,
      );
      expect(warm).toBeLessThan(FREEZE);
    }, 120_000);
  }
});

describe("what a rebuild is spent on", () => {
  /* Same wall, drawn with no per-tile layers: the difference between this and
   * the dressed number above is what the layers cost, and the remainder is the
   * floor — one background image object per tile, which no amount of
   * incremental rebuilding can avoid paying on a first open. */
  it("bare vs dressed at 301 tiles", async () => {
    const count = 301;
    const bare = emptyManifest();
    const p = newProject("Bare");
    p.order = Array.from({ length: count }, (_, i) => `4000000000${String(i).padStart(6, "0")}`);
    bare.projects = [p];
    for (const id of p.order) bare.tiles[id] = emptyTile();

    const canvas = wallCanvas(count);
    try {
      await buildGrid(canvas, view(bare), bare, testDeps, true);
      const start = performance.now();
      await buildGrid(canvas, view(bare), bare, testDeps, true);
      const ms = performance.now() - start;
      console.log(`${count} bare tiles: rebuild ${ms.toFixed(0)}ms`);
      expect(ms).toBeLessThan(FREEZE);
    } finally {
      await canvas.dispose();
    }
  }, 120_000);
});

describe("what a mask costs", () => {
  /* Settling the guess in cutToShape's ponytail note: a masked per-tile layer
   * is composited through two offscreen canvases, so a wall pays that per
   * masked layer per tile, on every rebuild. The note left it alone with
   * "cache by cutter + picture if a real wall ever feels slow" — a condition
   * nobody could check without a number. This is the number.
   *
   * The comparison is against the same wall with the mask taken off, so
   * everything else — the pictures, the shapes, the paint — cancels.
   *
   * Every tile here cuts the same picture with the same shape, which is the
   * best case a cache could ever have and not necessarily what anyone builds.
   * It answers "what does masking cost", not "would caching help" — see the
   * caveat on cutToShape before treating this number as a case for one. */
  const masked = (count: number, cut: boolean): Manifest => {
    const m = emptyManifest();
    const p = newProject("Masked");
    p.order = Array.from({ length: count }, (_, i) => `4000000000${String(i).padStart(6, "0")}`);
    m.projects = [p];
    for (const id of p.order) {
      const cutter = { ...newShapeLayer("ellipse"), id: `cut-${id}`, live: true, layoutId: "L1" };
      cutter.w = 0.5;
      cutter.h = 0.5;
      const pic = { ...newImageLayer("block:#00ff00"), id: `pic-${id}`, live: true, layoutId: "L1" };
      pic.scale = 0.6;
      if (cut) pic.maskId = cutter.id;
      m.tiles[id] = { ...emptyTile(), layers: [cutter, pic] };
    }
    return m;
  };

  const build = async (m: Manifest, count: number) => {
    const canvas = wallCanvas(count);
    try {
      await buildGrid(canvas, view(m), m, testDeps, true);
      const start = performance.now();
      await buildGrid(canvas, view(m), m, testDeps, true);
      return performance.now() - start;
    } finally {
      await canvas.dispose();
    }
  };

  it("compares a masked wall against the same wall unmasked", async () => {
    const count = 44;
    const plain = await build(masked(count, false), count);
    const cut = await build(masked(count, true), count);
    console.log(
      `${count} tiles: masked ${cut.toFixed(0)}ms, unmasked ${plain.toFixed(0)}ms ` +
        `(${(cut / plain).toFixed(1)}x, ${((cut - plain) / count).toFixed(1)}ms per masked tile)`,
    );
    expect(cut).toBeLessThan(FREEZE);
  }, 120_000);
});

describe("redrawing one tile", () => {
  /* What an edit costs on a wall the size the tool is heading for. GridCanvas
   * spends a full build only when more than one tile changed, so this is what
   * a caption nudge pays.
   *
   * The three numbers are reported together because the interesting one is the
   * gap between them. Building a tile's objects is what rebuildTile saves, and
   * it saves nearly all of it; painting the wall afterwards is a floor neither
   * path can go under, and at 301 tiles that floor is most of the cost.
   * Measured on one machine: full build 1013ms, one tile 415ms, of which
   * 407ms was the paint. Anything that makes a big wall feel quick from here
   * has to make the *render* cheaper — fewer objects on the canvas at low
   * zoom, not fewer objects rebuilt.
   *
   * Read those as one machine's shape, not as targets. The same commit gives
   * numbers 70% apart depending on what else is running, which is why nothing
   * here is asserted against a stopwatch — see FREEZE. */
  it("builds one tile instead of the wall at 301 tiles", async () => {
    const count = 301;
    const m = dressed(count);
    const wall = view(m);
    const target = wall.ids[Math.floor(count / 2)];
    const canvas = wallCanvas(count);
    try {
      await buildGrid(canvas, wall, m, testDeps, true);

      // The paint alone, with nothing rebuilt: the floor under both numbers.
      const paintStart = performance.now();
      canvas.renderAll();
      const paint = performance.now() - paintStart;

      const fullStart = performance.now();
      await buildGrid(canvas, wall, m, testDeps, true);
      const full = performance.now() - fullStart;

      const runs = 5;
      const oneStart = performance.now();
      for (let i = 0; i < runs; i++) await rebuildTile(canvas, target, wall, m, testDeps, true);
      const one = (performance.now() - oneStart) / runs;

      console.log(
        `${count} tiles: full ${full.toFixed(0)}ms, one tile ${one.toFixed(0)}ms, ` +
          `paint alone ${paint.toFixed(0)}ms → building one tile costs ` +
          `${(one - paint).toFixed(0)}ms against ${(full - paint).toFixed(0)}ms for the wall`,
      );
      /* Asserted against the full build from this same run, which is what
         makes it survive a loaded machine: both numbers move together, so the
         ratio holds where a wall-clock ceiling would not. Observed around 0.4;
         0.6 leaves room without letting a rebuild that saves nothing pass.

         The sharper figure — the construction cost with the paint taken off
         both sides — is printed but not asserted. It has come out negative,
         which is not a broken measurement: building one tile is smaller than
         the run-to-run variance of painting the wall, and that *is* the
         finding. A number below the noise floor cannot be a test. */
      expect(one).toBeLessThan(full * 0.6);
    } finally {
      await canvas.dispose();
    }
  }, 120_000);
});

/* A sanity check on the size these numbers are about, so a future change to
 * the grid maths cannot quietly move the goalposts. */
it("a 301-tile wall is 43 rows of 7", () => {
  const size = gridSize(301);
  expect(size.h).toBeGreaterThan(43 * TILE_H);
  expect(size.w).toBeLessThan(8 * TILE_W);
});
