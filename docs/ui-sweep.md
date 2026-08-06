# Briefing for a UI sweep

Read this before an exploratory pass over Tessera's interface. It is the *map*
— what the app is, how to drive it, what the words mean. It deliberately says
nothing about what was working last time: a sweep earns its keep by touching
what the people who built this stopped seeing, and a list of "already fine"
hands over exactly those blind spots.

Keep it short. A briefing that goes stale is worse than none, so only things
that change rarely belong here. If the test seam below stops matching the
code, fix this file in the same commit.

## What the app is

A portrait editor for Black Desert Online. It reads
`Documents\Black Desert\FaceTexture`, shows the character portraits as a grid,
and writes them back as 624×804 32bpp bottom-up BMPs. Tauri 2 + Svelte 5 +
TypeScript + Fabric.js, Windows only.

## Words

| Word | Meaning |
|---|---|
| **Kachel** (tile) | one portrait; one BMP file |
| **Ebene** (layer) | something drawn on top: image, text, shape, group |
| **Gruppe** | a named set of tiles plus a stack of layers. A tile belongs to **at most one** |
| **Layout** | a separate tile-sized document, composed on its own canvas |
| **Stempel** (stamp) | a Layout rendered to a flat PNG and dropped on a group as an image layer |

Two documents share one shell: the **Wand** (the whole grid) and one open
**Layout**. The header buttons and the right sidebar change with it.

The manifest is the only truth; Fabric is a view that writes deltas back, and
every edit is meant to reach disk immediately. Treat that as the invariant to
**check**, not as a guarantee: it has been false before, and the way it fails
is that the sidebar, the canvas and the file each show something different.

Two traps worth knowing before judging behaviour:

- A **stamp is frozen pixels.** Editing a Layout does not change what is on
  the tiles until "Stempel aktualisieren". A caption marked *pro Kachel* is
  the exception: it is kept out of the render and copied onto the group as a
  live layer, which is the only way per-tile wording can work.
- **Position and style are shared, wording is not.** One layer in a group is
  drawn on every tile of that group. Dragging any copy moves all of them.

## Running it

The app needs a Vite dev server on <http://localhost:1420>. If nothing is
listening, start one and say so in the report:

```
npm --prefix C:\Users\wsau\projects\tessera run dev
```

Leave it running when you finish. Do not start a second one.

Outside Tauri the app falls back to an in-memory filesystem
(`src/lib/platform.ts`) and opens a mock folder of 12 tiles `t00`..`t11`
automatically. Nothing touches the real disk. **Reloading the page wipes that
filesystem** — do it between scenarios for a clean slate.

## Test seam

`window.tessera` (dev builds only, see `src/main.ts`) exposes every export of
`src/lib/editor.svelte.ts` and `src/lib/platform.ts`. The useful ones:

- `tessera.app` — live state: `manifest`, `selectedTiles`, `selected`,
  `layoutSelection`, `openLayoutId`, `error`, `busy`, `version`
- `tessera.groups()`, `layouts()`, `openLayout()`, `freeCount()`
- `tessera.stashPickedFile(name, bytes)` → puts bytes in the mock filesystem,
  returns a path
- `tessera.queuePick(path)` → the next file-picker call returns that path
  instead of opening a chooser
- `tessera.history` — `past`/`future`. The only way to count what an action
  cost: "typing a word is one undo step" and "one per letter" look identical
  from outside, and so do a group drag worth one step and one worth three.
- `tessera.readTextFile(path)` — read the manifest back off the mock
  filesystem, at `<dir>/../FaceTexture.tessera/manifest.json`. The claim that
  the manifest is the only truth is worth checking rather than believing;
  comparing it against `tessera.app.manifest` after a burst of edits is what
  turns "an error appeared" into "the file on disk is behind the screen".

There is no way to drive an OS file dialog, which is what `queuePick` exists
for. Inserting a picture into a Layout:

```js
const c = new OffscreenCanvas(200, 200);
const g = c.getContext("2d");
g.fillStyle = "#ff00ff";
g.fillRect(0, 0, 200, 200);
const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
tessera.queuePick(tessera.stashPickedFile("bild.png", bytes));
await tessera.addLayoutImage();
```

`window.confirm` blocks a headless run. Override it before anything that
deletes — but record the message rather than only returning true, because two
of the warnings are themselves worth checking:

```js
let asked = [];
window.confirm = (m) => (asked.push(m), true);
```

Prefer real clicks over calling functions directly — the point is to exercise
the interface. Use the handle to set state up quickly and to read results out.

## Gestures

**Wall:** click picks a tile, Ctrl/Shift-click adds, drag sweeps a band over
tiles, **Alt+drag swaps two tiles**, right-click opens the group menu, a click
past the last tile clears everything, wheel zooms, space or middle-button
pans.

**Layout:** Ctrl-click in the layer list multi-selects, dragging snaps to the
sheet and to other layers (pink guides) with **Alt suppressing it**, shapes
stretch freely while **Shift constrains**, right-click a layer row for
grouping and moving.

Reordering rows is **native HTML5 drag-and-drop**, which synthetic mouse
events cannot drive at all — a coordinate drag there looks like a control that
silently does nothing, and will be reported as broken. Dispatch `DragEvent`s
instead: `dragstart` on the row being moved, then `dragover` on the target
with a `clientY` in its top, middle or bottom third (before / into / after),
then `drop`.

## Reading the noise

- Vite HMR and WebSocket messages in the console are not findings.
- An `hmr update` to `App.svelte` remounts the app, which re-runs
  `openFolder`: the manifest is re-read and undo history cleared. That is
  correct behaviour, and it has already produced one false "undo is broken"
  reading. If the source is being edited while you work, say so in the report
  and re-check anything decisive against a settled tree.
- **A background tab throttles `setTimeout` to about one second.** Any test
  where the delay itself is the point — undo steps collapsing while edits keep
  arriving, a debounce, anything with a window — will read wrong. Busy-wait on
  `performance.now()` for those. This has already produced one false "undo
  coalescing does not work" reading, off by a factor of twenty-five.
- After a run of failed HMR updates the page can be left half-loaded, throwing
  `X is not defined` for things that do exist. Reload before believing it.
- Screenshots lag the DOM by a frame after a click, and the coordinate-to-CSS
  scale changes with the window size. Before deciding from a picture that a
  control did nothing, confirm against `tessera.app`.

## What to report

One ordered list, worst first. Per finding: the exact steps, what happened
against what you expected, the evidence (the shortest decisive console line,
or the state read out of `tessera.app`), and whether it happens every time.

**A silent failure is the most valuable kind here** — nothing happening, with
no error, is a finding. Say plainly what you exercised that behaved, so the
coverage is known. If you cannot tell whether something is a bug or a
deliberate choice, report it as a question instead of guessing. Skip cosmetic
taste; report behaviour, inconsistency and errors.
