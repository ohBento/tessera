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

const { loadOriginal, assetUrl, saveManifest, loadManifest, restoreTiles, classify, svgWithSize, importAsset } =
  await import("./project");

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

describe("classify", () => {
  /* The whole point of M5, and the case that produced it: BDO keeps a numeric
   * id when a character slot is deleted and refilled, so "the file under this
   * id is not what we last saw" is the only signal there is. It cannot decide
   * on its own whether that means a restyle or a stranger — only the user
   * knows — so this sorts, and the UI asks. */
  const seen = (original: string, written?: string) => ({ original, written });

  it("calls an id we have never fingerprinted new, not changed", () => {
    // A first run, or a character created since the last one. Nothing was lost
    // and nothing needs deciding: it simply has to be visible.
    const out = classify({}, { a: "h1" });
    expect(out).toEqual({ fresh: ["a"], changed: [] });
  });

  it("accepts the file BDO shipped", () => {
    expect(classify({ a: seen("h1") }, { a: "h1" })).toEqual({ fresh: [], changed: [] });
  });

  it("accepts what Tessera itself wrote", () => {
    /* Without this every single open after a Write to game would report the
     * whole wall as changed — by the app's own hand. */
    expect(classify({ a: seen("h1", "h2") }, { a: "h2" })).toEqual({ fresh: [], changed: [] });
  });

  it("reports a file that matches neither", () => {
    expect(classify({ a: seen("h1", "h2") }, { a: "h3" })).toEqual({ fresh: [], changed: ["a"] });
  });

  it("says nothing about an id the folder no longer has", () => {
    // pruneToFolder already drops those; a second opinion here would only
    // disagree with it eventually.
    expect(classify({ gone: seen("h1") }, { a: "h1" })).toEqual({ fresh: ["a"], changed: [] });
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

describe("an SVG gets the size its viewBox already implies", () => {
  /* Without absolute width/height on the root there is nothing for an <img> to
   * measure, so the browser hands out the CSS default object size — 300×150 —
   * and Fabric takes that as the picture's size. A class icon then arrives in
   * the Layout at a number the file never said. */
  it("copies the viewBox onto a root that carries no size", () => {
    const out = svgWithSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 48"><path/></svg>');
    expect(out).toContain('width="64"');
    expect(out).toContain('height="48"');
    // The rest of the tag survives — the namespace above all, without which
    // nothing renders at all.
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).toContain("<path/>");
  });

  it("replaces a percentage rather than sitting beside it", () => {
    // "100%" resolves against a containing block an <img> never provides, so it
    // is no size at all — and left in place it would win, being first.
    const out = svgWithSize(`<svg width='100%' height='100%' viewBox="0 0 20 10"/>`)!;
    expect(out).not.toContain("100%");
    expect(out.match(/width=/g)).toHaveLength(1);
    expect(out).toContain('width="20"');
  });

  it("leaves a file that already knows its size alone", () => {
    expect(svgWithSize('<svg width="16" height="16" viewBox="0 0 64 64"/>')).toBeNull();
  });

  it("is not fooled by stroke-width", () => {
    // `\bwidth` matches the tail of it, which would read a line thickness as
    // the picture's width and leave the file untouched.
    const out = svgWithSize('<svg stroke-width="2" viewBox="0 0 30 30"/>');
    expect(out).toContain('width="30"');
  });

  it("has nothing to derive without a usable viewBox", () => {
    expect(svgWithSize("<svg><rect/></svg>")).toBeNull();
    expect(svgWithSize('<svg viewBox="0 0 0 10"/>')).toBeNull();
    expect(svgWithSize("not an svg at all")).toBeNull();
  });

  it("rewrites on the way into assets/, and hashes what it stored", async () => {
    files.clear();
    const platform = await import("./platform");
    const svg = '<svg viewBox="0 0 64 48"/>';
    vi.mocked(platform.readFile).mockResolvedValueOnce(new TextEncoder().encode(svg));
    const written: Array<[string, Uint8Array]> = [];
    vi.mocked(platform.writeFile).mockImplementation(async (path, data) => {
      written.push([String(path), data as Uint8Array]);
    });

    const name = await importAsset("/docs/FaceTexture", "C:/icons/klasse.svg");

    expect(name).toMatch(/\.svg$/);
    expect(new TextDecoder().decode(written[0][1])).toContain('width="64"');
    // Content-addressed on the bytes that landed, so the same icon imported
    // twice is still one file.
    expect(written[0][0]).toContain(name);
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
    const { manifest: m } = await loadManifest("/docs/FaceTexture", ["a", "c"]);
    const p = m.projects[0];
    expect(p.order).toEqual(["a"]);
    expect(p.shelf).toEqual(["c"]);
    expect(p.folders[0].tiles).toEqual(["a"]);
  });

  it("puts the document aside before dropping a tile that carried work", async () => {
    /* The scenario that cost the layers: BDO regenerates the folder, the ids
     * change, and the tiles built on the old ones are deleted on the next open
     * — with the undo history cleared in the same breath. The snapshot is the
     * only way back, so its being written is what this pins down. */
    files.clear();
    const platform = await import("./platform");
    const dressed = JSON.parse(stored());
    dressed.tiles.b.text = { L1: "Elani" };
    vi.mocked(platform.readTextFile).mockResolvedValueOnce(JSON.stringify(dressed));

    const { lost, snapshot } = await loadManifest("/docs/FaceTexture", ["a", "c"]);
    expect(lost).toEqual(["b"]);
    const written = [...files.keys()].find((k) => k.includes("/snapshots/"));
    expect(written).toContain(snapshot.replace(/:/g, "_"));
    // The un-pruned document: the tile is in there with its wording, which is
    // exactly what the prune is about to take away.
    expect(JSON.parse(files.get(written!)!).manifest.tiles.b.text).toEqual({ L1: "Elani" });
  });

  it("writes no snapshot when nothing of value goes", async () => {
    files.clear();
    const platform = await import("./platform");
    vi.mocked(platform.readTextFile).mockResolvedValueOnce(stored());
    // "b" is dropped, but it is an untouched tile — warning on that would mean
    // a warning on every ordinary open.
    const { lost, snapshot } = await loadManifest("/docs/FaceTexture", ["a", "c"]);
    expect(lost).toEqual([]);
    expect(snapshot).toBe("");
    expect([...files.keys()].some((k) => k.includes("/snapshots/"))).toBe(false);
  });

  it("adopts an id the folder has and no project claims", async () => {
    // That is all the inbox is: what nothing has taken. Nothing stores it.
    const platform = await import("./platform");
    vi.mocked(platform.readTextFile).mockResolvedValueOnce(stored());
    const { manifest: m } = await loadManifest("/docs/FaceTexture", ["a", "b", "c", "neu"]);
    expect(Object.keys(m.tiles)).toContain("neu");
    expect(projectOf(m, "neu")).toBeUndefined();
  });
});
