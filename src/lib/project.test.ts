import { describe, expect, it, vi } from "vitest";

/* The caches in project.ts hold promises, not values. A rejected one used to
 * stay cached, so one unlucky read became permanent — and because the render
 * chain awaits these, the canvas stopped rebuilding for the rest of the
 * session. These tests pin the retry behaviour to the observable thing: a
 * second call after a failure actually reaches the filesystem again. */

const readFile = vi.hoisted(() => vi.fn());
const exists = vi.hoisted(() => vi.fn(async () => false));

vi.mock("./platform", () => ({
  readFile,
  exists,
  join: async (...p: string[]) => p.join("/"),
  documentDir: async () => "/docs",
  readDir: vi.fn(async () => []),
  readTextFile: vi.fn(),
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  copyFile: vi.fn(),
  getVersion: vi.fn(),
  ask: vi.fn(),
  open: vi.fn(),
}));

vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1, height: 1 })));
// Patch the method rather than replacing URL: spreading it loses the
// constructor, and Vite's own module resolution needs `new URL` to work.
URL.createObjectURL = () => "blob:x";

const { loadOriginal, assetUrl } = await import("./project");

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
