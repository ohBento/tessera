<script lang="ts">
  /* The wall, as one Fabric canvas. Zooming out shows every portrait; zooming
   * in on a cell is what "editing a tile" means — there is no separate tile
   * editor and no separate mosaic placer, because they were only ever different
   * viewports onto this. */
  import * as fabric from "fabric";
  import { onMount } from "svelte";

  import {
    app,
    applyTransform,
    assignedTiles,
    clearAll,
    clearTiles,
    refreshCoverPreview,
    selectLayer,
    swapTilePlaces,
    wall,
    toggleTile,
    visibleIds,
  } from "./lib/editor.svelte";
  import { TILE_H, TILE_W } from "./lib/bmp";
  import { cellsIn, COLS, isTyping, snapBox, type Guide } from "./lib/geometry";
  import { buildGrid, cellAt, gridSize, readBack, snapScale, type Tagged } from "./lib/scene";

  let host: HTMLDivElement;
  let el: HTMLCanvasElement;
  let canvas: fabric.Canvas | undefined = $state();
  let zoom = $state(1);
  /** Wheel zoom switched off. View state, so it is gone again on restart —
   *  the same rule every other "what am I looking at" flag in this app follows. */
  let zoomLocked = $state(false);
  /** Tile a swap-drag is currently hovering, drawn by the after:render hook. */
  let dropTarget = "";
  /** The rubber band being dragged, in scene coordinates, or null. */
  let band: { x: number; y: number; w: number; h: number } | null = null;
  let bandStart: fabric.Point | null = null;

  /** Lines a dragged wall picture has been pulled onto, drawn by the
   *  after:render hook. Empty except during a drag. */
  let guides: Guide[] = [];
  /** How close in screen pixels the pull reaches. Converted to scene units per
   *  drag, so it feels the same at any zoom. */
  const SNAP_PX = 8;

  /** Every visible tile the band touches. */
  function tilesIn(r: { x: number; y: number; w: number; h: number }): string[] {
    const ids = visibleIds();
    return cellsIn(r, ids.length).map((i) => ids[i]);
  }

  /** The tile under a pointer event, or "" past the last one.
   *
   *  Exported because the context menu lives in App but only this component
   *  knows the viewport transform that turns a screen point into a cell. */
  export function tileAtEvent(e: MouseEvent): string {
    if (!canvas) return "";
    const p = canvas.getScenePoint(e);
    const col = Math.floor(p.x / TILE_W);
    const row = Math.floor(p.y / TILE_H);
    const ids = visibleIds();
    const index = row * COLS + col;
    const inside = col >= 0 && col < COLS && row >= 0 && index >= 0 && index < ids.length;
    return inside ? ids[index] : "";
  }

  const MIN_ZOOM = 0.02;
  const MAX_ZOOM = 8;

  /** Scale and centre the wall so all of it is visible. */
  function fit() {
    if (!canvas) return;
    const grid = gridSize(visibleIds().length);
    if (!grid.h) return;
    const z = Math.min(canvas.getWidth() / grid.w, canvas.getHeight() / grid.h) * 0.95;
    canvas.setViewportTransform([
      z,
      0,
      0,
      z,
      (canvas.getWidth() - grid.w * z) / 2,
      (canvas.getHeight() - grid.h * z) / 2,
    ]);
    zoom = z;
  }

  /* Fabric's dispose() is asynchronous. Building a new canvas on the same
   * element before the previous one has finished tearing down leaves it in a
   * state where nothing renders and nothing is reported — so every rebuild
   * waits on the one before it. */
  let building: Promise<unknown> = Promise.resolve();
  let built = -1;
  /* Clearing the canvas drops Fabric's active object, which fires
   * selection:cleared. Letting that reach the model would mean every structural
   * edit — hide, delete, reorder, assign, undo — silently deselected the layer
   * being worked on, and the actions that need one would then do nothing. */
  let rebuilding = false;

  /* One pending rebuild at a time; the pending one reads the newest state when
   * it starts. A burst of edits used to queue one full teardown-and-rebuild
   * per event, each drawing a state already several changes stale. */
  let queued = false;

  function rebuild(deps: typeof app.deps) {
    if (queued) return building;
    queued = true;
    building = building
      .then(async () => {
        queued = false;
        const version = app.version;
        if (!canvas || !deps) return;
        // Fit *before* building, not after: the tile count comes from the
        // manifest, so the viewport can be right from the first frame instead of
        // showing the wall at 100% and then visibly snapping down to fit.
        if (built < 0) fit();
        rebuilding = true;
        try {
          /* Snapshotted together with the manifest. The id list is the grid's
           * coordinate system — the index into it positions every cell — so it
           * has to be the same list the hit-testing below reads, not a second
           * derivation that could disagree by one. */
          const view = $state.snapshot(wall());
          await buildGrid(canvas, view, $state.snapshot(app.manifest), deps, true);
        } finally {
          rebuilding = false;
        }
        built = version;
      })
      /* Every later rebuild — and both effects that wait on this chain — is
       * queued with building.then(...), and a rejected promise never runs the
       * callbacks queued after it. One failed build would therefore stop the
       * wall from ever redrawing again, while the model kept changing
       * underneath: measured as zero draw calls after a single throw. Catching
       * keeps the chain resolvable, and leaving `built` alone means the next
       * version bump retries instead of giving up. */
      .catch((e) => {
        app.error = `The view could not be built: ${e}`;
      });
    return building;
  }

  $effect(() => {
    // Read both so the effect re-runs when either changes.
    const version = app.version;
    const deps = app.deps;
    if (canvas && deps && version !== built) void rebuild(deps);
  });

  /* Which tiles a selected wall picture would actually be baked into. Keyed on
     the pick and on structural change; a drag recomputes it itself, since a
     move does not bump the version. */
  $effect(() => {
    app.selected;
    app.version;
    void refreshCoverPreview();
  });

  /* The tile highlight is painted in the after:render hook, and Fabric only
   * renders when something asks it to — so a selection change has to. */
  $effect(() => {
    app.selectedTiles.join();
    app.selected;
    app.hoverFolder;
    app.hoverTile;
    app.coverPreview.join();
    canvas?.requestRenderAll();
  });

  /* A click on the wall always means "pick a tile". Only the layer chosen in
   * the sidebar stays grabbable, so it can still be dragged and scaled — every
   * other object is inert. That replaces the old V/M mode: a full-wall picture
   * used to swallow every click, and the mode existed purely to get past it.
   *
   * Fabric decides hit testing per object, so this writes the same switch
   * makeInteractive flips for a locked layer — and therefore has to keep the
   * lock, not overwrite it. Without the `!locked`, picking a padlocked layer
   * in the sidebar handed it straight back: anything a Layout owns could be
   * dragged on the wall, and "Stempel aktualisieren" then threw half of those
   * nudges away and kept the other half. */
  $effect(() => {
    if (!canvas) return;
    const chosen = app.selected;
    app.version;
    void building.then(() => {
      if (!canvas) return;
      for (const o of canvas.getObjects()) {
        const mine = (o as Tagged).layerId;
        if (mine) o.evented = o.selectable = mine === chosen && !(o as Tagged).locked;
      }
      // A rubber band would only ever catch the one grabbable object.
      canvas.selection = false;
      canvas.requestRenderAll();
    });
  });

  /* List selection -> canvas. Also keyed on version, because a rebuild replaces
   * every object and the id alone would not have changed. */
  $effect(() => {
    const id = app.selected;
    app.version;
    if (!canvas) return;
    void building.then(() => {
      if (!canvas) return;
      if ((canvas.getActiveObject() as Tagged | null)?.layerId === id) return;
      const obj = id && canvas.getObjects().find((o) => (o as Tagged).layerId === id);
      if (obj) canvas.setActiveObject(obj);
      else canvas.discardActiveObject();
      canvas.requestRenderAll();
    });
  });

  onMount(() => {
    canvas = new fabric.Canvas(el, {
      backgroundColor: "#161c21",
      preserveObjectStacking: true,
      // A model with a single `scale` per image cannot store a stretch, so
      // corner handles must never produce one.
      uniformScaling: true,
    });
    /* Dev-only handle, same reason as the one in main.ts: anything asking what
     * the canvas is actually showing — control positions, the viewport
     * transform, which object is active — has no other way in, and a sweep of
     * this app burned real time reaching it by patching Fabric's prototype. */
    if (import.meta.env.DEV) Object.assign(window, { tesseraWall: canvas });

    const resize = () => {
      canvas?.setDimensions({ width: host.clientWidth, height: host.clientHeight });
      canvas?.renderAll();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    canvas.on("mouse:wheel", (opt) => {
      /* Still swallowed while locked, or the wheel would scroll the page
       * behind the wall instead — the lock is against the accident, and
       * trading one accident for another is not a lock. Panning keeps working:
       * it needs a held key or the middle button, which nobody does by
       * mistake. */
      if (zoomLocked) {
        opt.e.preventDefault();
        opt.e.stopPropagation();
        return;
      }
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, canvas!.getZoom() * 0.999 ** opt.e.deltaY));
      canvas!.zoomToPoint(new fabric.Point(opt.e.offsetX, opt.e.offsetY), next);
      zoom = next;
      opt.e.preventDefault();
      opt.e.stopPropagation();
    });

    /* Panning: middle button, or space held like every other editor. Left-drag
     * on empty canvas stays a rubber-band selection. */
    let panning = false;
    let last = { x: 0, y: 0 };
    let spaceHeld = false;

    const tileAt = (e: MouseEvent) => tileAtEvent(e);

    /* Two gestures share one drag, told apart by Alt.
     *
     * A bare drag sweeps a band and picks every tile it touches — the common
     * one, so it gets the bare gesture. Alt+drag carries one tile onto another
     * and swaps them. A modifier rather than "where did the drag start": the
     * grid is dense, bare canvas exists only outside it, so a start-point rule
     * would put a band across the middle out of reach. */
    let dragFrom = "";
    let swapping = false;
    /** Tiles already picked when a band started, so Shift/Ctrl can add to them. */
    let bandBase: string[] = [];

    canvas.on("mouse:down", (opt) => {
      if (!(opt.e instanceof MouseEvent)) return;
      if (opt.e.button === 1 || spaceHeld) {
        panning = true;
        canvas!.selection = false;
        last = { x: opt.e.clientX, y: opt.e.clientY };
        opt.e.preventDefault();
        return;
      }
      // A layer object swallows the click only when it is the chosen one; every
      // other object is inert, so "no target" means bare wall.
      if (opt.e.button !== 0 || opt.target) return;
      dragFrom = tileAt(opt.e);
      swapping = opt.e.altKey && !!dragFrom;
      band = null;
      bandStart = canvas!.getScenePoint(opt.e);
      const additive = opt.e.ctrlKey || opt.e.shiftKey;
      bandBase = additive ? [...app.selectedTiles] : [];
      if (!dragFrom && !additive) clearAll();
    });

    canvas.on("mouse:move", (opt) => {
      if (!(opt.e instanceof MouseEvent)) return;
      if (panning) {
        canvas!.relativePan(new fabric.Point(opt.e.clientX - last.x, opt.e.clientY - last.y));
        last = { x: opt.e.clientX, y: opt.e.clientY };
        return;
      }
      if (!bandStart) return;

      if (swapping) {
        const over = tileAt(opt.e);
        const next = over && over !== dragFrom ? over : "";
        if (next !== dropTarget) {
          dropTarget = next;
          canvas!.requestRenderAll();
        }
        return;
      }

      const now = canvas!.getScenePoint(opt.e);
      // A few screen pixels of slop, so a click with a shaky hand stays a click.
      if (!band && Math.hypot(now.x - bandStart.x, now.y - bandStart.y) * canvas!.getZoom() < 4)
        return;
      band = {
        x: Math.min(bandStart.x, now.x),
        y: Math.min(bandStart.y, now.y),
        w: Math.abs(now.x - bandStart.x),
        h: Math.abs(now.y - bandStart.y),
      };
      const swept = new Set([...bandBase, ...tilesIn(band)]);
      // Kept in wall order rather than sweep order, so the selection reads the
      // same however the band was drawn.
      app.selectedTiles = visibleIds().filter((id) => swept.has(id));
      canvas!.requestRenderAll();
    });
    canvas.on("mouse:up", (opt) => {
      panning = false;
      canvas!.selection = false;
      const from = dragFrom;
      const onto = dropTarget;
      const wasBand = !!band;
      const wasSwap = swapping;
      dragFrom = "";
      dropTarget = "";
      swapping = false;
      band = null;
      bandStart = null;
      canvas!.requestRenderAll();
      if (!(opt.e instanceof MouseEvent)) return;

      if (wasSwap && onto) void swapTilePlaces(from, onto);
      // A band has already set the selection while it was dragged; a plain
      // click toggles the tile it landed on. Mouse-down past the last tile
      // already cleared everything, layer included.
      else if (!wasBand && from && tileAt(opt.e) === from)
        toggleTile(from, { ctrl: opt.e.ctrlKey, shift: opt.e.shiftKey });
    });

    /* Tile boundaries. Drawn straight onto the context after Fabric has
     * finished, in screen coordinates — which keeps them exactly one pixel wide
     * at any zoom, and keeps them out of the export: this hook lives on the
     * editor canvas, and export renders through a StaticCanvas that never has
     * it. Adding them as Fabric objects instead would have put them in the BMP.
     * Each existing cell is stroked individually rather than drawing full-width
     * lines, so a ragged last row shows only the tiles that are really there. */
    canvas.on("after:render", (opt) => {
      const ctx = opt?.ctx ?? canvas?.getContext();
      const vt = canvas?.viewportTransform;
      /* Only the object canvas. Fabric fires this once per canvas — again for
       * the interaction layer it draws handles and the selection box on — and
       * that one is cleared only by the next renderTop(). A copy of the grid
       * painted there therefore survives every zoom and pan happening
       * underneath it: a second lattice frozen at the transform it was drawn
       * at, and tile marks that outlive the selection that made them. Measured
       * on the top canvas: 61456 opaque pixels after one renderTop, still
       * 61456 after panning 180px. */
      if (!ctx || !vt || ctx !== canvas?.getContext()) return;
      const ids = visibleIds();
      if (!ids.length) return;
      const picked = new Set(app.selectedTiles);
      // Where the selected layer actually lands. Two separate marks on purpose:
      // "these are chosen" and "the layer already covers these" are different
      // facts, and assigning is the act of making the second match the first.
      const assigned = new Set(assignedTiles());
      const w = Math.round(TILE_W * vt[0]);
      const h = Math.round(TILE_H * vt[3]);
      ctx.save();
      /* CSS pixels, not device pixels. On a display scaled past 100% — every
       * laptop, most Windows desktops — Fabric renders into a backing store
       * devicePixelRatio times larger and bakes that factor into the context.
       * Resetting to the identity threw the factor away, so the whole lattice
       * drew at 1/dpr scale toward the top-left: a second, wrong grid hovering
       * over the real one, diverging further the more you zoomed and panned.
       * Proven by pixel probe: guide at x=20, the tile edge it belongs to at
       * x=30, retina 1.5. */
      const dpr = canvas?.getRetinaScaling() ?? 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const [i, id] of ids.entries()) {
        const at = cellAt(i);
        // The half-pixel offset puts a 1px line on a pixel rather than
        // straddling two, which otherwise renders as a soft 2px grey smear.
        const x = Math.round(at.x * vt[0] + vt[4]) + 0.5;
        const y = Math.round(at.y * vt[3] + vt[5]) + 0.5;

        if (assigned.has(id)) {
          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = "rgba(255, 196, 92, 0.95)";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
          ctx.setLineDash([]);
        }

        if (id === dropTarget) {
          // Where a swap would land. Filled rather than outlined: during a drag
          // the cursor is over this cell and an outline sits under the pointer.
          ctx.fillStyle = "rgba(255, 196, 92, 0.3)";
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = "rgba(255, 196, 92, 1)";
          ctx.lineWidth = 3;
        } else if (picked.has(id)) {
          ctx.fillStyle = "rgba(120, 220, 255, 0.22)";
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = "rgba(140, 225, 255, 0.95)";
          ctx.lineWidth = 2;
        } else {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
          ctx.lineWidth = 1;
        }
        /* The row under the pointer, in its own colour and after the rest, so
         * it wins the outline without taking the fill that says "picked" —
         * pointing at a tile is not choosing it. Yellow already means both "a
         * drawer holds this" and "the picture lands here"; a fourth meaning in
         * a colour already carrying two is a mark nobody can read. */
        if (id === app.hoverTile) {
          ctx.strokeStyle = "rgba(130, 235, 160, 0.95)";
          ctx.lineWidth = 2;
        }
        ctx.strokeRect(x, y, w, h);
      }

      /* Where a dragged wall picture has been pulled flush with the wall. Drawn
       * across the whole viewport, so it is obvious which edge caught it even
       * when the picture hangs far past the grid. */
      if (guides.length) {
        ctx.strokeStyle = "rgba(255, 90, 200, 0.95)";
        ctx.lineWidth = 1;
        for (const g of guides) {
          ctx.beginPath();
          if (g.axis === "x") {
            const x = Math.round(g.at * vt[0] + vt[4]) + 0.5;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, ctx.canvas.height);
          } else {
            const y = Math.round(g.at * vt[3] + vt[5]) + 0.5;
            ctx.moveTo(0, y);
            ctx.lineTo(ctx.canvas.width, y);
          }
          ctx.stroke();
        }
      }

      /* The band itself, on top of the marks it is producing. Drawn here
       * rather than through Fabric's own selection rectangle, because that one
       * selects objects and this one selects tiles — different things that
       * merely look alike. */
      if (band) {
        ctx.fillStyle = "rgba(120, 220, 255, 0.10)";
        ctx.strokeStyle = "rgba(140, 225, 255, 0.9)";
        ctx.lineWidth = 1;
        const bx = Math.round(band.x * vt[0] + vt[4]) + 0.5;
        const by = Math.round(band.y * vt[3] + vt[5]) + 0.5;
        const bw = Math.round(band.w * vt[0]);
        const bh = Math.round(band.h * vt[3]);
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeRect(bx, by, bw, bh);
      }
      ctx.restore();
    });

    const pickedOnCanvas = (opt: { selected?: fabric.Object[]; target?: fabric.Object }) => {
      if (rebuilding) return;
      selectLayer(((opt.selected?.[0] ?? opt.target) as Tagged | undefined)?.layerId ?? "");
    };
    canvas.on("selection:created", pickedOnCanvas);
    canvas.on("selection:updated", pickedOnCanvas);
    /* Clearing during a rebuild is Fabric dropping its active object, not the
     * user letting go of the layer — letting that through would silently
     * deselect on every structural edit. */
    canvas.on("selection:cleared", () => {
      if (!rebuilding) selectLayer("");
    });

    /* Snapping a wall picture to the wall.
     *
     *  Baking reaches a tile only if the picture covers it whole, so the one
     *  arrangement that never loses a row is the one where the picture encloses
     *  the grid — and the grid's own box is therefore the only thing worth
     *  snapping to here. Its edges and its centre, on each axis independently,
     *  the same rule the Layout editor uses against the sheet.
     *
     *  Grid-space objects only. A tile layer lives inside one cell; pulling it
     *  onto the far edge of the wall would be a snap to something it has no
     *  relationship with. */
    canvas.on("object:moving", (opt) => {
      guides = [];
      const target = opt.target as Tagged | undefined;
      if (!target || target.space !== "grid" || (opt.e as MouseEvent | undefined)?.altKey) return;

      /* Fabric has written the new left/top but not refreshed the cached corner
       * coordinates getBoundingRect reads — without this the box is one
       * drag-step stale and the correction lands short. */
      target.setCoords();
      const grid = gridSize(visibleIds().length);
      // Threshold in screen pixels, converted here, so the pull feels the same
      // however far the view is zoomed out — and the wall is usually far out.
      const snap = snapBox(
        target.getBoundingRect(),
        [{ left: 0, top: 0, width: grid.w, height: grid.h }],
        SNAP_PX / canvas!.getZoom(),
      );
      if (!snap.dx && !snap.dy) return;

      target.set({ left: (target.left ?? 0) + snap.dx, top: (target.top ?? 0) + snap.dy });
      target.setCoords();
      guides = snap.guides;
    });

    /* The same pull on the handles. A wall picture is sized to cover the grid
     * and the last few pixels are exactly the ones that decide whether a whole
     * column gets a crop — dragging a corner to a box edge by eye is how a row
     * goes missing. Uniform, because a picture carries one scale. */
    canvas.on("object:scaling", (opt) => {
      guides = [];
      const target = opt.target as Tagged | undefined;
      const corner = opt.transform?.corner;
      if (!target || !corner || target.space !== "grid") return;
      if ((opt.e as MouseEvent | undefined)?.altKey) return;
      const grid = gridSize(visibleIds().length);
      guides = snapScale(
        target,
        corner,
        [{ left: 0, top: 0, width: grid.w, height: grid.h }],
        SNAP_PX / canvas!.getZoom(),
        true,
      );
    });

    const dropGuides = () => {
      if (!guides.length) return;
      guides = [];
      canvas?.requestRenderAll();
    };
    canvas.on("mouse:up", dropGuides);
    canvas.on("selection:cleared", dropGuides);

    canvas.on("object:modified", (opt) => {
      const obj = opt.target as Tagged | undefined;
      if (!obj?.layerId) return;
      const ids = visibleIds();
      void applyTransform(obj, readBack(obj, ids.length, ids.indexOf(obj.tileId)));
    });

    const key = (e: KeyboardEvent, down: boolean) => {
      if (e.code !== "Space") return;
      // Not while typing into a field, or the space bar stops producing spaces.
      if (isTyping(document.activeElement)) return;
      spaceHeld = down;
      host.style.cursor = down ? "grab" : "";
      if (down) e.preventDefault();
    };
    const onDown = (e: KeyboardEvent) => key(e, true);
    const onUp = (e: KeyboardEvent) => key(e, false);
    addEventListener("keydown", onDown);
    addEventListener("keyup", onUp);

    return () => {
      ro.disconnect();
      removeEventListener("keydown", onDown);
      removeEventListener("keyup", onUp);
      const dying = canvas;
      canvas = undefined;
      void dying?.dispose();
    };
  });
</script>

<div class="host" bind:this={host}>
  <canvas bind:this={el}></canvas>
  <div class="hud">
    {Math.round(zoom * 100)}% &middot; {zoomLocked ? "Rad = gesperrt" : "Rad = Zoom"} &middot; Leertaste
    oder Mittelklick = Schieben
    <button
      onclick={() => (zoomLocked = !zoomLocked)}
      title={zoomLocked ? "Mausrad zoomt wieder" : "Mausrad zoomt nicht mehr"}
    >
      {zoomLocked ? "🔒" : "🔓"} Zoom
    </button>
    <button onclick={fit}>Einpassen</button>
  </div>
</div>

<style>
  .host {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .hud {
    position: absolute;
    left: 8px;
    bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 4px;
    background: rgb(0 0 0 / 0.6);
    color: #cfd6dc;
    font: 12px/1.4 ui-sans-serif, system-ui, sans-serif;
    pointer-events: auto;
  }
  .hud button {
    font: inherit;
    padding: 2px 8px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #1b2228;
    color: inherit;
    cursor: pointer;
  }
</style>
