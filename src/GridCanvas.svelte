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
    clearTiles,
    selectLayer,
    toggleTile,
    visibleIds,
  } from "./lib/editor.svelte";
  import { TILE_H, TILE_W } from "./lib/bmp";
  import { COLS } from "./lib/geometry";
  import { buildGrid, cellAt, gridSize, readBack, type Tagged } from "./lib/scene";

  let host: HTMLDivElement;
  let el: HTMLCanvasElement;
  let canvas: fabric.Canvas | undefined = $state();
  let zoom = $state(1);

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

  function rebuild(version: number, deps: typeof app.deps) {
    building = building.then(async () => {
      if (!canvas || !deps) return;
      // Fit *before* building, not after: the tile count comes from the
      // manifest, so the viewport can be right from the first frame instead of
      // showing the wall at 100% and then visibly snapping down to fit.
      if (built < 0) fit();
      rebuilding = true;
      try {
        await buildGrid(canvas, $state.snapshot(app.manifest), deps, true);
      } finally {
        rebuilding = false;
      }
      built = version;
    });
    return building;
  }

  $effect(() => {
    // Read both so the effect re-runs when either changes.
    const version = app.version;
    const deps = app.deps;
    if (canvas && deps && version !== built) void rebuild(version, deps);
  });

  /* The tile highlight is painted in the after:render hook, and Fabric only
   * renders when something asks it to — so a selection change has to. */
  $effect(() => {
    app.selectedTiles.join();
    app.selected;
    canvas?.requestRenderAll();
  });

  /* In tile mode nothing on the canvas is a hit target, so a click always
   * reaches the wall underneath — which a full-wall picture would otherwise
   * swallow entirely. The active object keeps its handles on purpose: it shows
   * which layer the tiles are about to be assigned to. */
  $effect(() => {
    if (!canvas) return;
    canvas.skipTargetFind = app.mode === "tiles";
    // A rubber band that can never hit anything is just noise.
    canvas.selection = app.mode === "layers";
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
      backgroundColor: "#101418",
      preserveObjectStacking: true,
      // A model with a single `scale` per image cannot store a stretch, so
      // corner handles must never produce one.
      uniformScaling: true,
    });

    const resize = () => {
      canvas?.setDimensions({ width: host.clientWidth, height: host.clientHeight });
      canvas?.renderAll();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    canvas.on("mouse:wheel", (opt) => {
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

    canvas.on("mouse:down", (opt) => {
      if (!(opt.e instanceof MouseEvent)) return;
      if (opt.e.button === 1 || spaceHeld) {
        panning = true;
        canvas!.selection = false;
        last = { x: opt.e.clientX, y: opt.e.clientY };
        opt.e.preventDefault();
        return;
      }
      // Clicking past every layer picks tiles instead. Backgrounds are inert,
      // so "no target" means the click landed on bare wall, and the cell is
      // whichever one the scene coordinate falls in.
      if (opt.e.button !== 0 || opt.target) return;
      const p = canvas!.getScenePoint(opt.e);
      const col = Math.floor(p.x / TILE_W);
      const row = Math.floor(p.y / TILE_H);
      const ids = visibleIds();
      const index = row * COLS + col;
      const inside = col >= 0 && col < COLS && row >= 0 && index >= 0 && index < ids.length;
      if (inside) toggleTile(ids[index], opt.e.ctrlKey || opt.e.shiftKey);
      else clearTiles();
    });
    canvas.on("mouse:move", (opt) => {
      if (!panning || !(opt.e instanceof MouseEvent)) return;
      canvas!.relativePan(new fabric.Point(opt.e.clientX - last.x, opt.e.clientY - last.y));
      last = { x: opt.e.clientX, y: opt.e.clientY };
    });
    canvas.on("mouse:up", () => {
      panning = false;
      canvas!.selection = app.mode === "layers";
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
      if (!ctx || !vt) return;
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
      ctx.setTransform(1, 0, 0, 1, 0, 0);
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

        if (picked.has(id)) {
          ctx.fillStyle = "rgba(120, 220, 255, 0.22)";
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = "rgba(140, 225, 255, 0.95)";
          ctx.lineWidth = 2;
        } else {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
          ctx.lineWidth = 1;
        }
        ctx.strokeRect(x, y, w, h);
      }
      ctx.restore();
    });

    const pickedOnCanvas = (opt: { selected?: fabric.Object[]; target?: fabric.Object }) => {
      if (rebuilding) return;
      selectLayer(((opt.selected?.[0] ?? opt.target) as Tagged | undefined)?.layerId ?? "");
    };
    canvas.on("selection:created", pickedOnCanvas);
    canvas.on("selection:updated", pickedOnCanvas);
    /* Only a real click in layer mode clears. Switching to tile mode also makes
     * Fabric drop its active object, and letting that through would break the
     * one workflow needing both: pick the layer here, the tiles there, assign. */
    canvas.on("selection:cleared", () => {
      if (!rebuilding && app.mode === "layers") selectLayer("");
    });

    canvas.on("object:modified", (opt) => {
      const obj = opt.target as Tagged | undefined;
      if (!obj?.layerId) return;
      const ids = visibleIds();
      void applyTransform(obj, readBack(obj, ids.length, ids.indexOf(obj.tileId)));
    });

    const key = (e: KeyboardEvent, down: boolean) => {
      if (e.code !== "Space") return;
      // Not while typing into a field, or the space bar stops producing spaces.
      if (document.activeElement instanceof HTMLInputElement) return;
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
    {Math.round(zoom * 100)}% &middot; Rad = Zoom &middot; Leertaste oder Mittelklick = Schieben
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
