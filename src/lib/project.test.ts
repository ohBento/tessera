import { describe, expect, it, vi } from "vitest";

import { emptyManifest, newProject, projectOf } from "./model";

/* The caches in project.ts hold promises, not values. A rejected one used to
 * stay cached, so one unlucky read became permanent — and because the render
 * chain awaits these, the canvas stopped rebuilding for the rest of the
 * session. These tests pin the retry behaviour to the observable thing: a
 * second call after a failure actually reaches the filesystem again. */

const readFile = vi.hoisted(() => vi.fn());
const exists = vi.hoisted(() => vi.fn(async (_p?: string) => false));

/* A filesystem that takes a moment, so two writes started in the same tick
 * really do overlap — an instant mock would hide the very race under test. */
const files = vi.hoisted(() => new Map<string, string>());
const tick = vi.hoisted(() => () => new Promise((r) => setTimeout(r, 1)));
const writeTextFile = vi.hoisted(() => vi.fn());
const rename = vi.hoisted(() => vi.fn());

vi.mock("./platform", () => ({
  readFile,
  exists,
  join: async (...p: string[]) => p.join("/"),
  documentDir: async () => "/docs",
  readDir: vi.fn(async () => []),
  readTextFile: vi.fn(),
  writeFile: vi.fn(),
  writeTextFile,
  mkdir: vi.fn(),
  remove: vi.fn(),
  rename,
  copyFile: vi.fn(),
  getVersion: vi.fn(),
  ask: vi.fn(),
  open: vi.fn(),
}));

writeTextFile.mockImplementation(async (path: string, text: string) => {
  await tick();
  files.set(path, text);
});
rename.mockImplementation(async (from: string, to: string) => {
  await tick();
  const held = files.get(from);
  if (held === undefined) throw new Error(`not found: ${from}`);
  files.delete(from);
  files.set(to, held);
});

vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1, height: 1 })));
// Patch the method rather than replacing URL: spreading it loses the
// constructor, and Vite's own module resolution needs `new URL` to work.
URL.createObjectURL = () => "blob:x";

const { loadOriginal, assetUrl, saveManifest, loadManifest, restoreTiles } = await import("./project");

describe("saveManifest survives overlapping writes", () => {
  /** Dragging a multi-selection fires one save per member in the same tick.
   *  Unserialised, the second write clobbers the temp file the first is about
   *  to rename and one of them fails outright — a lost write against a real
   *  disk, not just a message. */
  it("lands the newest state and leaves no temp behind when three overlap", async () => {
    files.clear();
    rename.mockClear();
    const m = (n: number) => ({ ...emptyManifest(), order: [`v${n}`] });

    await Promise.all([saveManifest("/d", m(1)), saveManifest("/d", m(2)), saveManifest("/d", m(3))]);

    expect(files.get("/d/../FaceTexture.tessera/manifest.json")).toContain("v3");
    expect([...files.keys()].some((k) => k.endsWith(".tmp"))).toBe(false);
    // Superseded rather than all written: the last state contains the others,
    // and writing each stage of a document still being edited helps nobody.
    expect(rename.mock.calls.length).toBeLessThan(3);
  });

  it("keeps going after one write fails", async () => {
    files.clear();
    rename.mockRejectedValueOnce(new Error("disk full"));
    await expect(saveManifest("/d", emptyManifest())).rejects.toThrow("disk full");
    await expect(saveManifest("/d", emptyManifest())).resolves.toBeUndefined();
  });
});

describe("a failed read does not poison the cache", () => {
  it("retries loadOriginal after a failure, and caches the success", async () => {
    readFile.mockRejectedValueOnce(new Error("disk hiccup"));
    await expect(loadOriginal("/dir", "t01")).rejects.toThrow("disk hiccup");

    readFile.mockResolvedValueOnce(new Uint8Array([1]));
    await expect(loadOriginal("/dir", "t01")).resolves.toBeTruthy();

    // Third call is served from cache — no fourth filesystem read.
    const calls = readFile.mock.calls.length;
    await loadOriginal("/dir", "t01");
    expect(readFile.mock.calls.length).toBe(calls);
  });

  it("retries assetUrl after a failure", async () => {
    readFile.mockRejectedValueOnce(new Error("gone"));
    await expect(assetUrl("/dir", "a.png")).rejects.toThrow("gone");

    readFile.mockResolvedValueOnce(new Uint8Array([1]));
    await expect(assetUrl("/dir", "a.png")).resolves.toBe("blob:x");
  });
});

describe("restoreTiles", () => {
  /* Putting the game's own portraits back is the way out of a wall that went
   * wrong, and it must never depend on the manifest: the vault is the record of
   * what BDO shipped, and a tile with no vault copy was simply never written to
   * — there is nothing to undo and nothing to report. */
  it("copies back only the tiles that were ever written, and counts them", async () => {
    const platform = await import("./platform");
    const copyFile = vi.mocked(platform.copyFile);
    copyFile.mockClear();
    // "b" was never written to the game, so it has no vault copy.
    exists.mockImplementation(async (p) => !!p && p.includes("/vault/") && !p.includes("b.bmp"));

    const n = await restoreTiles("/docs/FaceTexture", ["a", "b", "c"]);

    expect(n).toBe(2);
    const targets = copyFile.mock.calls.map((c) => String(c[1]));
    expect(targets).toEqual(["/docs/FaceTexture/a.bmp", "/docs/FaceTexture/c.bmp"]);
    // Copied *out of* the vault, not into it: the direction is the whole point.
    expect(String(copyFile.mock.calls[0][0])).toContain("/vault/");
  });

  it("reports zero when nothing was ever written", async () => {
    exists.mockImplementation(async () => false);
    expect(await restoreTiles("/docs/FaceTexture", ["a"])).toBe(0);
  });
});

describe("loadManifest lines the manifest up with the folder", () => {
  /* The folder is the authority: characters come and go between sessions, and
   * the whole folder can be deleted and regenerated. Driven through the real
   * entry point, because the pruning being *called* is the half a unit test of
   * the pruning cannot show. */
  const stored = () => {
    const m = emptyManifest();
    const p = newProject("Main");
    p.order = ["a", "b"];
    p.shelf = ["c"];
    p.folders = [{ id: "f1", name: "Done", tiles: ["a", "b"] }];
    m.projects = [p];
    for (const id of ["a", "b", "c"]) m.tiles[id] = { base: null, layers: [], text: {} };
    return JSON.stringify(m);
  };

  it("drops tiles the folder no longer has from grid, shelf and drawers", async () => {
    const platform = await import("./platform");
    vi.mocked(platform.readTextFile).mockResolvedValueOnce(stored());
    const m = await loadManifest("/docs/FaceTexture", ["a", "c"]);
    const p = m.projects[0];
    expect(p.order).toEqual(["a"]);
    expect(p.shelf).toEqual(["c"]);
    expect(p.folders[0].tiles).toEqual(["a"]);
  });

  it("adopts an id the folder has and no project claims", async () => {
    // That is all the inbox is: what nothing has taken. Nothing stores it.
    const platform = await import("./platform");
    vi.mocked(platform.readTextFile).mockResolvedValueOnce(stored());
    const m = await loadManifest("/docs/FaceTexture", ["a", "b", "c", "neu"]);
    expect(Object.keys(m.tiles)).toContain("neu");
    expect(projectOf(m, "neu")).toBeUndefined();
  });
});
