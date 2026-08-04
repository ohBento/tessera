# Tessera: Fabric.js Migration Plan

Status: proposal, not started. Written for a dedicated session — do not fold into a feature-drip batch.

## Why

`TileEditor.svelte` hand-rolls everything a canvas editor library already solves: drag/select boxes, multi-select drag, group bounding boxes, gradient fills, glow, masking, and (requested but not built) in-canvas text editing with a live cursor. Every one of the last several sessions shipped a new bug in this hand-rolled layer (box math, offset drag, stale selection state, padding-box vs content-box positioning). Fabric.js solves all of it natively:

- `fabric.Group` — grouping, group bounding box, group drag
- `ActiveSelection` — multi-select drag without grouping
- `fabric.Textbox` — live in-canvas text editing, blinking cursor, auto-growing box
- `clipPath` — masking one object to another's outline (shape *or* text)
- Built-in gradients, shadows (for glow), blend-mode-adjacent filters
- Object transform handles (resize/rotate) for free, instead of building our own

## Scope boundary — what moves, what stays

**Moves to Fabric** (all of `TileEditor.svelte`'s interactive canvas):
- Rendering the live editable preview
- Selection, multi-select, drag, rotate, resize
- Grouping/ungrouping
- Masking (clipPath)
- In-canvas text editing

**Stays exactly as-is** (everything outside the live editor canvas):
- `Manifest`/`Layer` JSON data model (`model.ts`) — the source of truth on disk
- BMP export path (`render.ts`'s `drawTile`/`exportBmp`, `bmp.ts`) — Fabric is not involved in producing the final `.bmp`; export renders the *data model*, not the Fabric canvas
- Vault/backup, snapshots, mosaic placement, project file I/O (`project.ts`, `state.svelte.ts`)
- The 60-tile grid view (`App.svelte`) — thumbnails still render via the existing headless Canvas2D path, not Fabric (Fabric per-tile would be 60 canvases for nothing)

This is the one design decision that matters: **Fabric owns interaction, our own `render.ts` still owns truth and export.** Fabric's canvas is a *view* onto the same `Layer[]` model, kept in sync in both directions. This avoids a second parallel format and means BMP export never depends on Fabric being loaded at all (important for a Tauri build — no headless-Fabric-in-Rust nonsense).

## The hard part: two-way sync between `Layer[]` and Fabric objects

This is the actual engineering work, not the library swap itself.

- **Model → Fabric**: on opening a tile, walk `eff.layers` and construct matching Fabric objects (`fabric.Rect`/`Ellipse`/`Polygon`/`Textbox`/`Image`/`Group`), positioned from the same `x`/`y`/`rotation`/`w`/`h` fractions (scaled to canvas pixels). A small `layerToFabric(layer): fabric.Object` per kind.
- **Fabric → Model**: on every `object:modified` (and `text:changed` for live content), write the changed properties back into the corresponding `Layer` in the manifest, then run the existing `afterEdit()`/`commit()` path unchanged — undo, dirty-tracking, and disk persistence don't need to know Fabric exists.
- **Identity**: give every Fabric object a `data.layerId` matching the model's `id` so the two directions can find each other without guessing.
- **Masking**: `layer.maskId` → resolve the target Fabric object, set `fabricObj.clipPath = targetFabricObj` (Fabric supports clipPath by shape *or* by a text object's rendered glyphs — this alone replaces the destination-in compositing hack in `render.ts` for the *editor preview*; the BMP export path keeps its own compositing since it doesn't run Fabric).
- **Groups**: `fabric.Group` nesting maps directly to `GroupLayer.children` — closest of any part of the model to a 1:1 mapping.

## Phased plan

1. **Spike (half a day, throwaway code)**: get Fabric rendering a single tile's layers read-only in a scratch Svelte component, no editing, no sync-back. Confirms the coordinate mapping (tile-fraction ↔ Fabric px) and that masking/groups/gradients look right before committing to the rewrite.
2. **One-way sync (model → Fabric)**: replace `TileEditor`'s canvas rendering with Fabric, still read-only from the model's point of view (drag doesn't persist yet). Selection boxes, group boxes, multi-select highlighting all become free — delete `boxSize`/`collectBoxes`/`.sel-box` entirely.
3. **Write-back**: wire `object:modified`/`text:changed` to update the model and call `afterEdit()`. This is where undo/redo, dirty-tracking, and shared-vs-detached-layer editing need re-verification — they're keyed off the model, but every mutation path needs to go through it now instead of direct Svelte bindings.
4. **Feature parity pass**: re-implement each side-panel field (sliders for size/opacity/blend/glow/etc.) as Fabric-property writes instead of direct model writes, keeping the same UI. Text alignment, gradients, glow become either native Fabric features or thin wrappers.
5. **Delete the old code**: `boxSize`, `collectBoxes`, `onDown`/`onMove`/`onUp` drag handling, `.sel-box` CSS, the manual paint-mask compositing in the *editor preview specifically* (render.ts's export path is untouched).
6. **Regression pass against every bug fixed this month**: group box centering, offset-preserving multi-drag, mask-to-text, stage padding offset — confirm Fabric doesn't reintroduce any of them structurally.

## Open risks / questions for the planning session

- **Bundle size**: Fabric is ~300KB min+gzip-ish depending on version/tree-shaking. Fine for a Tauri desktop app (no mobile bandwidth concern), but worth confirming against the current ~115KB total bundle for context.
- **Svelte 5 integration**: Fabric is framework-agnostic (imperative canvas API), which is actually a good fit for Svelte 5's `$effect`-based lifecycle, but the binding code (mounting the Fabric canvas, tearing it down on tile switch, keeping `$state` in sync with Fabric's own event system) needs a clean pattern decided up front, not discovered mid-rewrite.
- **Fabric version**: v6 is the current major (ESM-first, TypeScript types included) — use that, not v5/CDN-era Fabric.
- **Text-as-mask via clipPath**: confirm Fabric's `Textbox` can actually serve as a `clipPath` source (i.e., clip by glyph shape) before relying on it — if not, the destination-in compositing already built in `render.ts` may need to stay as the editor-preview mask renderer too, with Fabric only handling the *other* masking case (shape targets).
- **Performance**: 60-tile grid stays on the existing headless path (per Scope boundary above) specifically to avoid this, but worth a quick sanity check that mounting/unmounting one Fabric canvas per tile-editor-open is cheap enough (should be — it's one canvas at a time, not 60).

## What this plan deliberately does not cover

- Migrating the grid thumbnail rendering to Fabric (explicitly out of scope, see above)
- Any new features beyond parity with what already exists/was requested — this is a foundation swap, not a feature session
