/* saveTiles is the one action that reaches out of the app and that Ctrl+Z
 * cannot take back: it overwrites the game's own portraits. renderTiles beside
 * it has thirty-odd test uses and saveTiles had none, so the two rules it
 * exists to enforce — vault before the first overwrite, and record what landed
 * however the loop ended — were unguarded.
 *
 * A browser test because renderTiles goes through Fabric, and against
 * platform.ts's in-memory filesystem, which is a real filesystem as far as
 * every line under test is concerned. */
import { describe, expect, it, beforeEach, vi } from "vitest";

/** Lets one write fail, so the half-finished save can be inspected. There is no
 *  other way in: the mock filesystem cannot be made to lock a file. */
const failAt = vi.hoisted(() => ({ name: "" }));

vi.mock("./platform", async (importOriginal) => {
  const real = await importOriginal<typeof import("./platform")>();
  return {
    ...real,
    writeFile: async (path: string, bytes: Uint8Array) => {
      /* The temp file as well as the target: a tile is written beside itself
         and renamed into place, so the write that can fail is the one to
         `t01.bmp.tmp`. Matching only the final name meant the stub stopped
         firing the day that changed, and the test passed by writing everything
         successfully. */
      if (failAt.name && (path.endsWith(failAt.name) || path.endsWith(`${failAt.name}.tmp`)))
        throw new Error("locked by the game");
      return real.writeFile(path, bytes);
    },
  };
});

const { saveTiles } = await import("./export");
const { readFile, readTextFile, resetMockFiles } = await import("./platform");
const { emptyManifest, emptyTile, newProject } = await import("./model");
const { testDeps } = await import("../test/images");

const DIR = "/mock/Documents/Black Desert/FaceTexture";
const PROJECT = "/mock/Documents/Black Desert/FaceTexture.tessera";
const game = (id: string) => `${DIR}/${id}.bmp`;
const vault = (id: string) => `${PROJECT}/vault/${id}.bmp`;

/** A wall of ids the mock folder actually holds a portrait for. */
function wall(ids: string[]) {
  const m = emptyManifest();
  const p = newProject("Main");
  p.order = ids;
  m.projects = [p];
  for (const id of ids) m.tiles[id] = emptyTile();
  return { m, view: { ids: p.order, gridLayers: p.gridLayers } };
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

beforeEach(() => {
  failAt.name = "";
  resetMockFiles();
});

describe("saveTiles vaults before it overwrites", () => {
  it("keeps the game's own bytes in the vault and the rendered ones in the folder", async () => {
    /* Vaulting before the first overwrite is the only thing standing between a
     * user and unrecoverable portraits, and "before" is the whole claim: a
     * vault copy taken one line later holds Tessera's own output, which
     * restores nothing. */
    const { m, view } = wall(["t00", "t01"]);
    const pristine = await readFile(game("t00"));

    const n = await saveTiles(DIR, view, m, testDeps);

    expect(n).toBe(2);
    expect(same(await readFile(vault("t00")), pristine)).toBe(true);
    // And the folder really did change, or the assertion above proves nothing.
    expect(same(await readFile(game("t00")), pristine)).toBe(false);
  });

  it("never overwrites a vault copy that is already there", async () => {
    // The second write is not the original any more. A vault that takes the
    // newest copy is a vault that forgets what the game shipped.
    const { m, view } = wall(["t00"]);
    const pristine = await readFile(game("t00"));

    await saveTiles(DIR, view, m, testDeps);
    await saveTiles(DIR, view, m, testDeps);

    expect(same(await readFile(vault("t00")), pristine)).toBe(true);
  });
});

describe("saveTiles records what landed, however the loop ended", () => {
  it("saves the fingerprints of the tiles it got to before a write failed", async () => {
    /* A locked file or a full disk at tile seven used to leave six portraits
     * written and not one `written` hash saved: on the next open none of them
     * matched either hash, so the app reported its own work as "changed in the
     * game" — and answering that with "new characters" costs the layers and the
     * vault copies. */
    const { m, view } = wall(["t00", "t01"]);
    failAt.name = "t01.bmp";

    await expect(saveTiles(DIR, view, m, testDeps)).rejects.toThrow("locked by the game");

    const prints = JSON.parse(await readTextFile(`${PROJECT}/fingerprints.json`));
    expect(typeof prints.t00?.written).toBe("string");
    // The one that never landed is not claimed as ours.
    expect(prints.t01).toBeUndefined();
    /* And the game's own file for it is untouched — not half a portrait. The
     * write goes to a temp file beside it and is renamed into place, so the
     * folder holds either the old picture or the new one. A truncated BMP
     * would read as "changed in the game" on the next open, and the answer
     * that fits what the user sees is the one that deletes its vault copy. */
    expect(same(await readFile(game("t01")), await readFile(vault("t01")))).toBe(true);
  });

  it("records every tile when nothing goes wrong", async () => {
    const { m, view } = wall(["t00", "t01"]);

    await saveTiles(DIR, view, m, testDeps);

    const prints = JSON.parse(await readTextFile(`${PROJECT}/fingerprints.json`));
    expect(Object.keys(prints).sort()).toEqual(["t00", "t01"]);
  });
});
