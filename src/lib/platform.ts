/* The handful of host calls Tessera makes, behind one switch.
 *
 * In the Tauri window these go to the real plugins. In a plain browser — the
 * Vite dev server on its own, or a Vitest browser test — they go to an
 * in-memory filesystem instead, so the whole app runs and can be clicked
 * without a native shell.
 *
 * Same reasoning as SceneDeps in scene.ts: the render chain became testable
 * the moment its pixel sources were injected rather than imported. This is
 * that idea applied to the filesystem, and it is one module rather than a
 * parameter threaded through every function because there is exactly one
 * implementation per environment and the choice is made once, at startup.
 *
 * Importing the Tauri plugins is safe everywhere — they only reach for
 * window.__TAURI_INTERNALS__ when a function is actually called. */
import { getVersion as tauriVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { documentDir as tauriDocumentDir, join as tauriJoin } from "@tauri-apps/api/path";
import { ask as tauriAsk, open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import {
  copyFile as tCopyFile,
  exists as tExists,
  mkdir as tMkdir,
  readDir as tReadDir,
  readFile as tReadFile,
  readTextFile as tReadTextFile,
  remove as tRemove,
  rename as tRename,
  writeFile as tWriteFile,
  writeTextFile as tWriteTextFile,
} from "@tauri-apps/plugin-fs";

import { encodeBmp32, TILE_H, TILE_W } from "./bmp";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Whether this is the shipped application rather than a browser build.
 *
 *  Exported for the one caller that needs to know the difference rather than
 *  be shielded from it: the update check has nothing to compare against
 *  outside Tauri, and asking anyway would have every test reach the network. */
export const isDesktop = inTauri;

/* --- In-memory filesystem. Flat: keys are full paths, directories exist only
 * as prefixes. Nothing here persists — reloading the page starts over, which
 * is the right default for a scratch environment and one less thing to clear
 * when a test leaves rubbish behind. --- */

const files = new Map<string, Uint8Array>();
const enc = new TextEncoder();
const dec = new TextDecoder();

const MOCK_DOCS = "/mock/Documents";
const MOCK_TILES = `${MOCK_DOCS}/Black Desert/FaceTexture`;
/** How many portraits the mock folder pretends to hold. */
const MOCK_COUNT = 12;

/** Resolves "." and ".." the way Tauri's join does, so paths built with
 *  join(dir, "..", "x") land in the same place in both environments. */
function joinMock(...parts: string[]): string {
  const out: string[] = [];
  for (const seg of parts.join("/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/** A solid-colour portrait, made on demand.
 *
 *  Generated rather than stored: a tile is 2 MB of pixels, and building the
 *  ones actually looked at keeps a mock folder from costing 24 MB up front.
 *  Colours are spread over the hue circle so tiles are told apart at a glance
 *  — which is what makes a screenshot of the grid readable. */
function mockTile(index: number): Uint8Array {
  const hue = (index * 360) / MOCK_COUNT;
  const c = 120;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = 60;
  const [r, g, b] = (
    [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ] as const
  )[Math.floor(hue / 60) % 6];
  const px = new Uint8ClampedArray(TILE_W * TILE_H * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r + m;
    px[i + 1] = g + m;
    px[i + 2] = b + m;
    px[i + 3] = 255;
  }
  return encodeBmp32(px);
}

const mockTileIndex = (path: string) => {
  const m = path.match(new RegExp(`^${MOCK_TILES}/t(\\d+)\\.bmp$`));
  return m ? Number(m[1]) : -1;
};

function memRead(path: string): Uint8Array {
  const held = files.get(path);
  if (held) return held;
  const index = mockTileIndex(path);
  if (index >= 0 && index < MOCK_COUNT) {
    const made = mockTile(index);
    files.set(path, made);
    return made;
  }
  throw new Error(`not found: ${path}`);
}

const memExists = (path: string) =>
  files.has(path) ||
  (mockTileIndex(path) >= 0 && mockTileIndex(path) < MOCK_COUNT) ||
  [...files.keys()].some((k) => k.startsWith(`${path}/`));

function memReadDir(path: string) {
  const names = new Set<string>();
  if (path === MOCK_TILES) {
    for (let i = 0; i < MOCK_COUNT; i++) names.add(`t${String(i).padStart(2, "0")}.bmp`);
  }
  for (const key of files.keys()) {
    if (!key.startsWith(`${path}/`)) continue;
    names.add(key.slice(path.length + 1).split("/")[0]);
  }
  return [...names].map((name) => ({ name, isFile: name.includes("."), isDirectory: !name.includes(".") }));
}

/** Files picked in the browser land here under a synthetic path, so the rest
 *  of the app keeps working with paths and never learns the difference. */
export function stashPickedFile(name: string, bytes: Uint8Array): string {
  const path = joinMock("/picked", name);
  files.set(path, bytes);
  return path;
}

/** Empties the mock filesystem — for tests that need a known starting point. */
export const resetMockFiles = () => files.clear();

/** Makes the next picker call return this path instead of showing a chooser.
 *  There is no way to drive an OS file dialog from a test, so without a seam
 *  like this every action that starts with "pick a file" would be untestable —
 *  which is most of the ones worth testing. Browser only. */
let queuedPick: string | null = null;
export const queuePick = (path: string) => (queuedPick = path);

/* --- The exported surface. Same names and shapes the Tauri plugins use, so
 * switching a call site over is only a change of import. --- */

export const documentDir = inTauri ? tauriDocumentDir : async () => MOCK_DOCS;

export const join = inTauri ? tauriJoin : async (...parts: string[]) => joinMock(...parts);

export const readFile = inTauri ? tReadFile : async (p: string) => memRead(p);

export const readTextFile = inTauri ? tReadTextFile : async (p: string) => dec.decode(memRead(p));

export const writeFile = inTauri
  ? tWriteFile
  : async (p: string, bytes: Uint8Array) => void files.set(p, bytes);

export const writeTextFile = inTauri
  ? tWriteTextFile
  : async (p: string, text: string) => void files.set(p, enc.encode(text));

export const exists = inTauri ? tExists : async (p: string) => memExists(p);

export const readDir = inTauri ? tReadDir : async (p: string) => memReadDir(p);

/** Directories are prefixes in the mock, so there is nothing to create. */
export const mkdir = inTauri ? tMkdir : async () => {};

export const remove = inTauri ? tRemove : async (p: string) => void files.delete(p);

export const rename = inTauri
  ? tRename
  : async (from: string, to: string) => {
      files.set(to, memRead(from));
      files.delete(from);
    };

export const copyFile = inTauri
  ? tCopyFile
  : async (from: string, to: string) => void files.set(to, memRead(from));

export const getVersion = inTauri ? tauriVersion : async () => "0.0.0-browser";

/** Opens a link in the machine's own browser.
 *
 *  Through here rather than straight from the component, like every other way
 *  out of this app: the browser tests mount the whole thing, and a bare import
 *  of a Tauri plugin takes them down with it. Outside Tauri it is a no-op —
 *  a test that opens a tab is a test that steals the focus. */
export const openUrl = inTauri ? tauriOpenUrl : async (_url: string) => {};

/** Font families installed on this machine.
 *
 *  From Rust, not from the web's `queryLocalFonts()`: that one is permission
 *  gated, and inside Tauri's custom-protocol origin the permission comes back
 *  denied with no prompt that could grant it — measured, it returns an empty
 *  list and no error, which is the worst of both.
 *
 *  Loaded once per session: the list cannot change while the app is open, and
 *  the properties panel is rebuilt every time the selection moves. */
let fontList: Promise<string[]> | undefined;
export const systemFonts = () =>
  (fontList ??= inTauri
    ? invoke<string[]>("system_fonts")
    : /* Outside Tauri there is no command to call. A handful that exist
       * everywhere is enough for the dev build and the tests; the packaged app
       * is where the real list matters. */
      Promise.resolve(["Arial", "Courier New", "Georgia", "Impact", "Times New Roman", "Verdana"]));

/** Confirmation dialog. The browser's own confirm() is blocking and ugly but
 *  it is a real yes/no, which is all the caller needs. */
export const ask = inTauri
  ? tauriAsk
  : async (message: string, opts?: { title?: string }) =>
      confirm(`${opts?.title ? `${opts.title}\n\n` : ""}${message}`);

/** File / folder picker. In the browser a hidden <input type="file"> stands in
 *  and the chosen bytes are stashed under a synthetic path. */
export const open = inTauri
  ? tauriOpen
  : async (opts?: { directory?: boolean }): Promise<string | null> => {
      if (queuedPick !== null) {
        const path = queuedPick;
        queuedPick = null;
        return path;
      }
      if (opts?.directory) return MOCK_TILES;
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = async () => {
          const file = input.files?.[0];
          resolve(file ? stashPickedFile(file.name, new Uint8Array(await file.arrayBuffer())) : null);
        };
        input.oncancel = () => resolve(null);
        input.click();
      });
    };
