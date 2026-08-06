import { describe, expect, it, vi } from "vitest";

import { emptyManifest } from "./model";

/* The caches in project.ts hold promises, not values. A rejected one used to
 * stay cached, so one unlucky read became permanent — and because the render
 * chain awaits these, the canvas stopped rebuilding for the rest of the
 * session. These tests pin the retry behaviour to the observable thing: a
 * second call after a failure actually reaches the filesystem again. */

const readFile = vi.hoisted(() => vi.fn());
const exists = vi.hoisted(() => vi.fn(async () => false));

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

const { loadOriginal, assetUrl, saveManifest } = await import("./project");

describe("saveManifest survives overlapping writes", () => {
  /** Dragging a multi-selection fires one save per member in the same tick.
   *  Unserialised, the second write clobbers the temp file the first is about
   *  to rename and one of them fails outright — a lost write against a real
   *  disk, not just a message. */
  it("writes every version in order when three are started at once", async () => {
    files.clear();
    const m = (n: number) => ({ ...emptyManifest(), order: [`v${n}`] });

    await Promise.all([saveManifest("/d", m(1)), saveManifest("/d", m(2)), saveManifest("/d", m(3))]);

    expect(rename).toHaveBeenCalledTimes(3);
    // Last one in wins, and nothing threw on the way.
    expect(files.get("/d/../FaceTexture.tessera/manifest.json")).toContain("v3");
    // No temp file left behind.
    expect([...files.keys()].some((k) => k.endsWith(".tmp"))).toBe(false);
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
