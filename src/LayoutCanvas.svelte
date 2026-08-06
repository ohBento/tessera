<script lang="ts">
  /* One Layout document, at tile size. Deliberately much smaller than
   * GridCanvas: no tile grid, no tile picking, no tool modes — a Layout is a
   * single 624x804 sheet, so the only thing to point at is a layer. The parts
   * that are the same are the same on purpose: they are the ones that cost real
   * debugging time (async dispose, the rebuild/selection race, fitting before
   * the first frame). */
  import * as fabric from "fabric";
  import { onMount } from "svelte";

  import { app, applyLayoutTransform, openLayout, selectLayoutLayer } from "./lib/editor.svelte";
  import { TILE_H, TILE_W } from "./lib/bmp";
  import { buildLayout, readBackLayout } from "./lib/scene";

  let host: HTMLDivElement;
  let el: HTMLCanvasElement;
  let canvas: fabric.Canvas | undefined = $state();
  let zoom = $state(1);

  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 8;

  /** Centre the sheet with a little breathing room around it. */
  function fit() {
    if (!canvas) return;
    const z = Math.min(canvas.getWidth() / TILE_W, canvas.getHeight() / TILE_H) * 0.9;
    canvas.setViewportTransform([
      z,
      0,
      0,
      z,
      (canvas.getWidth() - TILE_W * z) / 2,
      (canvas.getHeight() - TILE_H * z) / 2,
    ]);
    zoom = z;
  }

  /* Same reasoning as GridCanvas: Fabric's dispose() is asynchronous, and
   * clearing the canvas fires selection:cleared, which must not reach the model
   * or every structural edit would silently deselect the layer being worked on. */
  let building: Promise<unknown> = Promise.resolve();
  let built = "";
  let rebuilding = false;

  function rebuild(key: string, deps: typeof app.deps) {
    building = building.then(async () => {
      const layout = openLayout();
      if (!canvas || !deps || !layout) return;
      if (!built) fit();
      rebuilding = true;
      try {
        await buildLayout(canvas, $state.snapshot(layout), deps, true);
      } finally {
        rebuilding = false;
      }
      built = key;
    });
    return building;
  }

  /* Keyed on the open layout as well as the version: switching documents has to
   * rebuild even when nothing was edited. */
  $effect(() => {
    const key = `${app.openLayoutId}:${app.version}`;
    const deps = app.deps;
    if (canvas && deps && app.openLayoutId && key !== built) void rebuild(key, deps);
  });

  /* List selection -> canvas, re-run after a rebuild replaced every object. */
  $effect(() => {
    const id = app.layoutSelected;
    app.version;
    if (!canvas) return;
    void building.then(() => {
      if (!canvas) return;
      const active = canvas.getActiveObject() as (fabric.Object & { layerId?: string }) | null;
      if (active?.layerId === id) return;
      const obj = id && canvas.getObjects().find((o) => (o as { layerId?: string }).layerId === id);
      if (obj) canvas.setActiveObject(obj);
      else canvas.discardActiveObject();
      canvas.requestRenderAll();
    });
  });

  onMount(() => {
    canvas = new fabric.Canvas(el, {
      backgroundColor: "#0d1114",
      preserveObjectStacking: true,
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
      }
    });
    canvas.on("mouse:move", (opt) => {
      if (!panning || !(opt.e instanceof MouseEvent)) return;
      canvas!.relativePan(new fabric.Point(opt.e.clientX - last.x, opt.e.clientY - last.y));
      last = { x: opt.e.clientX, y: opt.e.clientY };
    });
    canvas.on("mouse:up", () => {
      panning = false;
      canvas!.selection = true;
    });

    /* The sheet's own edge, drawn in screen space after Fabric is done. A
     * Layout renders on transparency, so without this outline there is no way
     * to tell where the tile ends and empty space begins. Screen space keeps it
     * one pixel wide at any zoom, and this hook lives only on the editor canvas
     * — renderLayout uses a StaticCanvas that never has it, so the outline can
     * not leak into the stamped picture. */
    canvas.on("after:render", (opt) => {
      const ctx = opt?.ctx ?? canvas?.getContext();
      const vt = canvas?.viewportTransform;
      if (!ctx || !vt) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.round(vt[4]) + 0.5,
        Math.round(vt[5]) + 0.5,
        Math.round(TILE_W * vt[0]),
        Math.round(TILE_H * vt[3]),
      );
      ctx.restore();
    });

    const picked = (opt: { selected?: fabric.Object[]; target?: fabric.Object }) => {
      if (rebuilding) return;
      const obj = (opt.selected?.[0] ?? opt.target) as { layerId?: string } | undefined;
      selectLayoutLayer(obj?.layerId ?? "");
    };
    canvas.on("selection:created", picked);
    canvas.on("selection:updated", picked);
    canvas.on("selection:cleared", () => {
      if (!rebuilding) selectLayoutLayer("");
    });

    canvas.on("object:modified", (opt) => {
      const obj = opt.target as (fabric.Object & { layerId?: string }) | undefined;
      if (!obj?.layerId) return;
      void applyLayoutTransform(obj.layerId, readBackLayout(obj));
    });

    const key = (e: KeyboardEvent, down: boolean) => {
      if (e.code !== "Space") return;
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
    {Math.round(zoom * 100)}% &middot; {TILE_W}&times;{TILE_H}
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
