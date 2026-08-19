# Tessera

Portrait editor for Black Desert Online. It replaces the character-select portraits in
`Documents\Black Desert\FaceTexture` with your own — one at a time, or one picture
spread across the whole grid as a mosaic.

Windows only, because that is where the game keeps those files.

## The idea

**The grid is the canvas.** Every portrait in the folder is a tile on one zoomable
wall, and a tile is a crop of that wall rather than a document you open on its own. You
arrange forty-four characters while looking at all forty-four of them, and what you see
is what gets written.

Nothing reaches the game until you say so. Everything Tessera owns lives beside the
game folder, and the first time it overwrites a portrait the original goes into a vault
it never touches again.

## Download

The installer or `Tessera-portable.zip` from
[Releases](https://github.com/wsa67bytes/tessera/releases/latest). Portable is a single
`Tessera.exe` — no install, no service, nothing in the registry.

It needs the Microsoft Edge WebView2 runtime, which Windows 11 and current Windows 10
already have; the installer fetches it if it is missing.

## First run

Tessera opens `Documents\Black Desert\FaceTexture` by itself and reads every portrait
in it. You land on **Home**: a card per project, plus **Unsorted** for everything no
project has claimed and **Archive** for what you have put away.

The folder belongs to the Windows user rather than to a BDO account, so several
accounts share one — which is what projects are for. Pick tiles in Unsorted, press
**New project from selection**, and you have a wall.

## Working on a wall

### Tiles

A tile is one character's portrait. Pick them by clicking, ctrl-clicking, dragging a
box over them, or shift-clicking a range. Drag a tile to reorder the wall — that order
is the order in the game, and Tessera never reflows it behind your back.

Tiles you are finished with go into **drawers**, so a list of forty-four stays
readable; a drawer folds away in the list and changes nothing on the wall. Characters
that no longer exist go into the **Archive**: the game never deletes a portrait file,
so without somewhere to put them the folder only ever grows.

### Layers

Every tile carries a stack of layers — **pictures**, **captions**, **shapes**
(rectangle, ellipse, polygon) and **class icons**, thirty-three silhouettes narrowed by
typing. Layers can be **grouped**, folded away, given a colour so the eye can find them
again, duplicated, and dragged into or out of a group.

What a layer can do:

- Placement by dragging on the wall, by the number boxes, or with the arrow keys — a
  tile pixel per press, ten with Shift. Dragged edges snap to the cell and to the
  neighbouring layers; hold Alt to place freely.
- Opacity, rotation, flip, and a shadow that doubles as a glow when it has no offset.
- **Blend modes**, all thirteen the canvas has: Multiply, Screen, Overlay, Darken,
  Lighten, Colour dodge, Hard light, Difference, Hue, Saturation, Colour and
  Luminosity. A layer mixes with the portrait beneath it and with the layers below it
  at once — which of the two it meets is decided by where it sits in the stack.
- **Masks**: any layer clipped by any other — a shape by its outline, a picture by the
  pixels it actually has, a caption by its letters. Invertible, so it punches a hole
  instead of cutting a piece out.
- Pictures: crop by dragging the side handles, brightness, contrast, saturation, hue,
  blur, and a border with rounded corners.
- Captions: font, size, alignment, outline, a flat colour or a gradient, and a box that
  wraps the words and can be held to a fixed height. `{{id}}` expands to the portrait's
  own id.
- Shapes: fill or gradient, border, and a corner radius that can be set per corner.

**Align and distribute** line the picked layers up against their tile — six edges and
equal gaps along either axis — worked out per tile, so the same caption lands in the
same place on portraits where it is not the same width.

### One edit, many portraits

Pick several tiles and a field reaches all of them in one undo step. The panel's
heading says how many it is about to write to before you touch anything, and a drag
shows a frame around what will move on the other tiles. That is how one design goes
onto a whole wall: pick the tiles, change the thing once.

Every write is a named step, and the Undo button reads out what it is about to take
back rather than leaving you to press it and find out.

### The mosaic

Drop one picture across the whole grid and it is drawn under every tile at once.
**Apply** bakes it into each tile's background — the button says how many tiles lie
fully under the picture before you press it — and **Remove** takes it off again.

## Writing to the game

**Write to game** renders the wall and writes one BMP per tile into the game folder.
The first time a portrait is overwritten its untouched original goes into the vault,
which is never written to again, so **Reset in game** can always put the game's own
faces back — with your layers still in the document, ready to write again.

A **snapshot** is the whole document set aside under a name and walked back to later.
One is taken automatically before every write to the game.

If BDO changes a portrait behind Tessera's back — a restyled character, or a slot
deleted and refilled — the next open notices and asks, per character, whether to keep
the work that was on it or start over.

## Keyboard and mouse

| | |
|---|---|
| `Ctrl + Z` | Undo |
| `Ctrl + Y` · `Ctrl + Shift + Z` | Redo |
| `Delete` · `Backspace` | Take the picked layer off its tile |
| `Ctrl + D` | Duplicate the picked layer |
| Arrow keys | Nudge a tile pixel · with `Shift`, ten |
| `Escape` | Take back the drag in progress · drop the picked layer · close a sheet |
| Right-click a layer row | Duplicate, group, ungroup, copy and paste a look |
| Right-click the wall | Hide, lock, remove a layer, archive |
| `?` | The shortcut sheet |
| Wheel | Zoom |
| Middle-drag · `Space` + drag | Pan |
| Drag | Selection box over tiles |
| `Ctrl` + click | Add one tile, or one layer, to the selection |
| `Shift` + click | Take the whole range up to it |
| `Alt` + drag | Swap two tiles instead of selecting |
| `Alt` while dragging a handle | No snapping |
| Double-click | Rename a row |

## Where your data lives

Beside the game folder and never inside it, in
`Documents\Black Desert\FaceTexture.tessera`:

| | |
|---|---|
| `manifest.json` | The whole document: projects, tiles, layers |
| `assets/` | Every picture you have imported |
| `vault/` | The untouched original of every portrait ever overwritten |
| `snapshots/` | Named copies of the document |
| `manifest.v7.bak.json` | The document as an older build left it, kept the first time a newer one migrates it |

The manifest is written to a temporary file and renamed into place, so an interrupted
save cannot leave half a document behind.

## The target format

Verified against 60 real portrait files: 624 × 804, `BITMAPINFOHEADER`, 32 bpp
`BI_RGB`, bottom-up, alpha `0xFF` throughout. Tessera writes exactly what the game
itself writes. One of those sixty was 24 bpp, almost certainly the work of another
tool.

## Building it yourself

```bash
npm install
npm run tauri dev
```

```bash
npm test
```

The suite is Vitest in two projects: plain unit tests, and browser tests that run in a
real Chromium through Playwright — the renderer is Fabric.js on a canvas, and a
stand-in for that proves nothing about what gets drawn. Run `npx playwright install
chromium` once beforehand.

```bash
npm run release
```

Builds the installer and drops a portable `release\Tessera.exe` beside it. Pushing a
`v*` tag builds the same thing on CI and publishes it to Releases.

Stack: Tauri 2 for the shell, Svelte 5, Fabric.js, TypeScript. The Rust side does
almost nothing on purpose — it enumerates fonts and hands the webview its file access;
the drawing, the document and the BMP encoder are all TypeScript.

## Disclaimer

Not affiliated with, endorsed by, or connected to Pearl Abyss. "Black Desert Online" is
their trademark; it appears here only to say what this tool works with. It writes into
your game's portrait folder — that is its whole purpose — so use it at your own risk.
The vault and the snapshots are there to make that risk small, not zero.

## Licence

MIT. See [LICENSE](LICENSE).
