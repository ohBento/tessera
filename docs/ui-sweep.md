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
| **Tile** | one portrait; one BMP file |
| **Layer** | something drawn on top: image, text, shape, group |
| **Project** | one wall — which portraits belong together. A tile belongs to **at most one**; the FaceTexture folder is shared by every account on the machine, which is why projects exist |
| **Unsorted** | the tiles no project has claimed. Derived, never stored. It is a wall too |
| **Group** | a drawer in the tile list. Purely cosmetic: renders nothing, owns nothing, dissolving one moves no tile |
| **Shelf** | a project's tiles with no slot on its grid. Drag one onto the wall to place it |
| **Layout** | a separate tile-sized document, composed on its own canvas |
| **Stamp** | a Layout rendered to a flat PNG and dropped on **one tile** as an image layer |
| **Mask** | a layer clipped to the outline, pixels or letters of another layer in the same Layout. The one doing the cutting stops drawing itself |
| **Snapshot** | the document (manifest + fingerprints) put aside under a name, ~20 KB. Restoring one replaces the document and does **not** touch the game folder |

Two documents share one shell: the **wall** (the whole grid) and one open
**Layout**. The header buttons and the right sidebar change with it. The
sidebar's sections, top to bottom: Projects, Layouts, Snapshots, Shelf (only
when it has something), Groups, Tiles.

The manifest is the only truth; Fabric is a view that writes deltas back, and
every edit is meant to reach disk immediately. Treat that as the invariant to
**check**, not as a guarantee: it has been false before, and the way it fails
is that the sidebar, the canvas and the file each show something different.

Three traps worth knowing before judging behaviour:

- A **stamp is frozen pixels.** Editing a Layout does not change what is on
  the tiles until "Update stamps". A layer marked *Editable in grid* is the
  exception: it is kept out of the render and copied onto each tile as a live
  layer, which is the only way per-tile wording and per-tile logos can work.
- **A layer exists in exactly one place.** Every tile carries its own stack;
  nothing is shared between tiles. Two tiles wearing the same Layout hold two
  separate stamps of it.
- **A layer used as a mask deliberately vanishes.** It is the hole, not
  something in the picture, so it draws at opacity 0 and ignores the pointer —
  its row in the list is the only way to select and move it, and it only wakes
  up while that row is picked. "The shape disappeared" is the feature.

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
- `tessera.folders()` (the Groups), `layouts()`, `projects()`, `openProject()`,
  `openLayout()`, `visibleIds()`, `freeCount()`
- `tessera.stashPickedFile(name, bytes)` → puts bytes in the mock filesystem,
  returns a path
- `tessera.queuePick(path)` → the next file-picker call returns that path
  instead of opening a chooser
- `tessera.history` — `past`/`future`. The only way to count what an action
  cost: "typing a word is one undo step" and "one per letter" look identical
  from outside, and so do a group drag worth one step and one worth three.
- `tesseraWall` and `tesseraLayout` — the live Fabric canvases, on `window`
  next to `tessera` rather than inside it. Anything about what is actually on
  screen goes through these: control positions, the viewport transform, which
  object is active, what `scaleX` a drag left behind. `tesseraLayout` is
  `undefined` whenever no Layout is open. Each is **two** stacked canvases —
  `lowerCanvasEl`/`getContext()` for the objects, `upperCanvasEl`/`contextTop`
  for handles and the selection box — and `renderAll()` touches only the first.
  Reading pixels means saying which.
- `tessera.readTextFile(path)` — read the manifest back off the mock
  filesystem, at `/mock/Documents/Black Desert/FaceTexture.tessera/manifest.json`.
  Spell the path out: the mock filesystem does not resolve `..`, so building it
  from the folder path throws a `not found` naming a file that exists. The claim that
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

**Wall:** click picks a tile, **Ctrl-click adds one, Shift takes the range**
(over wall order, in the list as well as on the canvas), drag sweeps a band,
**Alt+drag swaps two tiles**, right-click opens the selection menu (new
project, move to another project, assign a layout to all of them, put them in
a group, send back to Unsorted), a click past the last tile clears everything,
wheel zooms unless the HUD's padlock is on, space or middle-button pans.

Picking a single tile opens its row in the sidebar and scrolls to it; picking
several only marks them. Only one tile row is open at a time.

**Layout:** Ctrl-click in the layer list multi-selects, dragging snaps to the
sheet and to other layers (pink guides) with **Alt suppressing it**, **handles
snap too** — the edge under the pointer catches on the sheet and the
neighbours — shapes stretch freely while **Shift constrains**, right-click a
layer row for grouping, duplicating and moving, Ctrl+D duplicates, double-click
the Layout's own tab to rename it.

A caption has **no scale handles at all**: its size is a font size and lives in
the properties panel. Rotate and move are all it offers.

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
- **Never await an animation frame.** `requestAnimationFrame` does not fire
  while the pane is hidden, so a helper waiting on one hangs until the tool
  times out. `setTimeout` is fine and has measured accurate here; do not
  busy-wait on `performance.now()` instead, which blocks the macrotask queue
  the app's own rebuild needs and hangs the thing it was meant to time.
  (A background tab *can* throttle timers to about a second, and that has
  produced one false "undo coalescing does not work" reading. If a delay is
  itself the point, measure the delay you actually got rather than assuming
  either way.)
- After a run of failed HMR updates the page can be left half-loaded, throwing
  `X is not defined` for things that do exist. Reload before believing it.
- **Screenshots may be unavailable outright** — "the Browser pane is not
  displayed, so the page is not compositing frames". Read the DOM and
  `tessera.app` instead; that is the better evidence anyway. When a screenshot
  does work it still lags the DOM by a frame after a click, and the
  coordinate-to-CSS scale changes with the window size.
- **A pixel probe is worthless until the canvas has a real size.** Mounted in
  a bare document — a browser test, a component rendered on its own — the stage
  collapses to about one pixel wide and the wall draws at 0.02% zoom, where
  every guide and every tile mark is sub-pixel. The probe then reads zero
  whatever the code does, and an assertion built on it passes against a bug
  that is plainly visible in the app. Set `setDimensions` and a workable
  `setViewportTransform` yourself, or check the numbers you are measuring are
  numbers at all before believing a clean result. This has already produced one
  green test against a live defect.
- **`requestRenderAll` will not fire while the pane is hidden** — it waits on
  an animation frame, the same reason never to await one. Call `renderAll()`
  directly when a measurement depends on the redraw having happened. A
  selection set from the console and then measured looks like "the highlight
  does not draw" otherwise.
- **Alt does double duty on the Layout canvas.** It suppresses snapping while
  dragging, and it is also Fabric's `centeredKey`: holding it through a handle
  drag makes the scale centred, which quietly doubles every factor you measure.
  Hold it for drags, never for scales.
- A handle drag only registers when the object is the canvas's active object.
  A stray click that cleared the selection turns the next one into a rubber
  band that does nothing — which looks exactly like a broken control.
- **An object with `evented: false` has no working handles either**, even while
  it is active: Fabric looks a control up by hit-testing the object first. That
  is why a mask's stencil is woken only while its row is picked, and why "the
  handles do nothing" on one is expected rather than a defect.

## What to report

One ordered list, worst first. Per finding: the exact steps, what happened
against what you expected, the evidence (the shortest decisive console line,
or the state read out of `tessera.app`), and whether it happens every time.

**A silent failure is the most valuable kind here** — nothing happening, with
no error, is a finding. Say plainly what you exercised that behaved, so the
coverage is known. If you cannot tell whether something is a bug or a
deliberate choice, report it as a question instead of guessing. Skip cosmetic
taste; report behaviour, inconsistency and errors.
