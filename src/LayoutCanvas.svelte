<script lang="ts">
  /* One Layout document, at tile size. Deliberately much smaller than
   * GridCanvas: no tile grid, no tile picking, no tool modes — a Layout is a
   * single 624x804 sheet, so the only thing to point at is a layer. The parts
   * that are the same are the same on purpose: they are the ones that cost real
   * debugging time (async dispose, the rebuild/selection race, fitting before
   * the first frame). */
  import * as fabric from "fabric";
  import { onMount } from "svelte";

  import {
    app,
    applyLayoutTransform,
    endGesture,
    openLayout,
    setLayerField,
    setLayoutSelection,
  } from "./lib/editor.svelte";
  import { TILE_H, TILE_W } from "./lib/bmp";
  import {
    alignBoxes,
    distributeBoxes,
    isTyping,
    snapBox,
    type AlignEdge,
    type Box,
    type Guide,
  } from "./lib/geometry";
  import { findLayer, walkLayers } from "./lib/model";
  import { buildLayout, freeScale, readBackLayout } from "./lib/scene";

  let host: HTMLDivElement;
  let el: HTMLCanvasElement;
  let canvas: fabric.Canvas | undefined = $state();
  let zoom = $state(1);

  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 8;
  /** How close, in screen pixels, before a drag is pulled into line. */
  const SNAP_PX = 8;

  /** Alignment guides for the drag in progress, in scene coordinates. */
  let guides: Guide[] = [];

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

  /* One pending rebuild at a time. A burst of edits — a slider being dragged,
   * a caption being typed — used to queue one teardown-and-rebuild per event
   * and then work through all of them, each drawing a state already three
   * changes out of date. The pending build reads the newest state when it
   * actually starts, so a burst costs two builds instead of thirty. */
  let queued = false;

  function rebuild(deps: typeof app.deps) {
    if (queued) return building;
    queued = true;
    building = building
      .then(async () => {
        queued = false;
        const layout = openLayout();
        const key = `${app.openLayoutId}:${app.version}`;
        if (!canvas || !deps || !layout) return;
        if (!built) fit();
        rebuilding = true;
        try {
          await buildLayout(canvas, $state.snapshot(layout), deps, true);
        } finally {
          rebuilding = false;
        }
        built = key;
      })
      /* Same reason as GridCanvas: a rejected chain never runs what was queued
       * after it, so one failed build would freeze this canvas for good. */
      .catch((e) => {
        app.error = `Anzeige konnte nicht aufgebaut werden: ${e}`;
      });
    return building;
  }

  /* Keyed on the open layout as well as the version: switching documents has to
   * rebuild even when nothing was edited. */
  $effect(() => {
    const key = `${app.openLayoutId}:${app.version}`;
    const deps = app.deps;
    if (canvas && deps && app.openLayoutId && key !== built) void rebuild(deps);
  });

  /* Everything but a shape is held proportional, and Fabric is told so up
   * front rather than corrected mid-drag.
   *
   * Clamping inside object:scaling looked equivalent and was not: it forced
   * the smaller axis up to the larger one on every pointer move, so a drag
   * that wandered sideways made the object jump in height and shift on screen,
   * and where it settled depended on the angle the pointer happened to come
   * back at. Setting uniformScaling instead lets Fabric scale from the anchor
   * it already keeps, which is what every editor does.
   *
   * uniScaleKey goes with it: Shift means "the other one", and for a layer
   * that cannot store a stretch there is no other one. */
  function scalingRules() {
    if (!canvas) return;
    const layout = openLayout();
    const ids = canvas.getActiveObjects().map((o) => (o as { layerId?: string }).layerId);
    const only = ids.length === 1 && layout ? findLayer(layout.layers, ids[0] ?? "") : undefined;
    // A multi-selection has no single answer — hold it proportional, which
    // cannot corrupt anything.
    const free = !!only && freeScale(only);
    canvas.uniformScaling = !free;
    canvas.uniScaleKey = free ? "shiftKey" : null;
    /* uniformScaling only governs the corner handles. An ActiveSelection shows
     * all four mid-side handles of its own accord, and those scale one axis
     * whatever it is set to — so a sideways stretch of a mixed selection made
     * the pictures and captions in it taller as well, and a rotated caption
     * came back at a different angle, because a non-uniform scale composed
     * with a rotation is a skew that the decomposition has to throw away. */
    if (!free) {
      canvas
        .getActiveObject()
        ?.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
    }
  }

  /** Every canvas object standing for one of these layer ids. A layer inside a
   *  group has no object of its own — its members do — so picking a group in
   *  the list grabs the members, which is what makes a group draggable. */
  function objectsFor(ids: string[]): fabric.Object[] {
    const layout = openLayout();
    if (!canvas || !layout) return [];
    const wanted = new Set<string>();
    for (const id of ids) {
      const found = findLayer(layout.layers, id);
      if (found?.kind === "group") for (const l of walkLayers(found.children)) wanted.add(l.id);
      else wanted.add(id);
    }
    /* Locked layers are left out. Fabric already refuses to catch one with a
     * click, but nothing stopped the list from handing it over — and a locked
     * layer inside an ActiveSelection is dragged and scaled with the rest,
     * which is exactly what the lock was for. */
    return canvas.getObjects().filter((o) => {
      const id = (o as { layerId?: string }).layerId ?? "";
      return wanted.has(id) && o.selectable !== false;
    });
  }

  /* GIMP's align tool, reduced to what a sheet needs: the reference is always
   * the sheet itself, distribute always works on the picked set. The moves go
   * through exactly the code path a finished drag takes — shift the Fabric
   * object, read it back, write the model — so nesting shifts, per-kind size
   * fields and undo grouping are the same one implementation. */
  function realign(compute: (boxes: Box[]) => { dx: number; dy: number }[]) {
    const c = canvas;
    if (!c) return;
    const objs = objectsFor(app.layoutSelection);
    if (!objs.length) return;

    /* Loose objects first: inside an ActiveSelection, left/top are relative to
     * the selection frame and the maths is in sheet coordinates. Discarding is
     * this component rearranging, not the user deselecting — same guard as the
     * selection effect above. */
    rebuilding = true;
    try {
      c.discardActiveObject();
    } finally {
      rebuilding = false;
    }
    for (const o of objs) o.setCoords();

    const deltas = compute(objs.map((o) => o.getBoundingRect()));
    const gesture = `align:${app.layoutSelection.join(",")}`;
    objs.forEach((o, i) => {
      const { dx, dy } = deltas[i];
      if (dx || dy) {
        o.set({ left: (o.left ?? 0) + dx, top: (o.top ?? 0) + dy });
        o.setCoords();
      }
      const id = (o as { layerId?: string }).layerId;
      if (id) void applyLayoutTransform(id, readBackLayout(o), gesture);
    });
    endGesture();

    // Put the selection frame back where the user had it.
    rebuilding = true;
    try {
      if (objs.length === 1) c.setActiveObject(objs[0]);
      else c.setActiveObject(new fabric.ActiveSelection(objs, { canvas: c }));
    } finally {
      rebuilding = false;
    }
    scalingRules();
    c.requestRenderAll();
  }

  const align = (edge: AlignEdge) =>
    realign((boxes) => alignBoxes(boxes, edge, { left: 0, top: 0, width: TILE_W, height: TILE_H }));
  const spread = (axis: "x" | "y") => realign((boxes) => distributeBoxes(boxes, axis));

  /* List selection -> canvas, re-run after a rebuild replaced every object.
   * More than one picked layer becomes an ActiveSelection, which is what gives
   * the whole set one transform frame and moves it as a unit. */
  $effect(() => {
    const ids = app.layoutSelection.join(" ");
    app.version;
    if (!canvas) return;
    void building.then(() => {
      if (!canvas) return;
      const objs = objectsFor(ids ? ids.split(" ") : []);
      const active = canvas.getActiveObject();
      const shown = active
        ? ((active as fabric.ActiveSelection).getObjects?.() ?? [active])
        : [];
      // Already showing exactly this set: leave it alone, or setting it again
      // would cancel the drag in progress that caused the change.
      if (shown.length === objs.length && shown.every((o, i) => o === objs[i])) return;

      /* Swapping the active object is this component obeying the model, not
       * the user choosing — and discardActiveObject fires selection:cleared,
       * which reported an empty pick back into the model. That emptied the
       * "already covered" set, so the setActiveObject on the next line then
       * looked like a fresh pick of the group's children: selecting a group
       * moved the selection onto its members after every structural edit. */
      rebuilding = true;
      try {
        canvas.discardActiveObject();
        if (objs.length === 1) canvas.setActiveObject(objs[0]);
        else if (objs.length > 1) {
          canvas.setActiveObject(new fabric.ActiveSelection(objs, { canvas }));
        }
      } finally {
        rebuilding = false;
      }
      // The selection changed without a Fabric event, so the rules that hang
      // off it have to be refreshed by hand.
      scalingRules();
      canvas.requestRenderAll();
    });
  });

  onMount(() => {
    canvas = new fabric.Canvas(el, {
      backgroundColor: "#0d1114",
      preserveObjectStacking: true,
      /* Free by default, Shift constrains — the convention everywhere else,
       * and the common case should not need a key held down. Only shapes can
       * actually take it; anything else is forced back to proportional in
       * object:scaling, because its model has one size field, not two. */
      uniformScaling: false,
    });
    // Dev-only handle; see the same line in GridCanvas.
    if (import.meta.env.DEV) Object.assign(window, { tesseraLayout: canvas });

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
    /** A drag/scale/rotate is in flight — the window in which Esc can still
     *  take it back, because the model is only written at the end of it. */
    let transforming = false;
    /** Swallows the write-back a cancelled gesture's mouse release still
     *  fires. Cleared at mouse:up either way, so it can never go stale and
     *  eat a later, legitimate transform. */
    let cancelled = false;

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
      // Fabric fires object:modified before mouse:up within the same release,
      // so by here a cancelled gesture has already been swallowed.
      transforming = false;
      cancelled = false;
    });
    canvas.on("object:scaling", () => (transforming = true));
    canvas.on("object:rotating", () => (transforming = true));

    /* Snapping. Fabric has none of its own, so the pull happens here: on every
     * step of a drag, line the moving box up with the sheet and with every
     * layer that is not being dragged, then nudge it by the difference.
     *
     * It only ever attracts — outside the threshold nothing happens, and Alt
     * turns it off entirely — so a layer can still be pushed anywhere,
     * including off the sheet. */
    /* Everything but a shape is held proportional, and Fabric is told so up
     * front rather than corrected mid-drag.
     *
     * Clamping inside object:scaling looked equivalent and was not: it forced
     * the smaller axis up to the larger one on every pointer move, so a drag
     * that wandered sideways made the object jump in height and shift on
     * screen, and where it settled depended on the angle the pointer happened
     * to come back at. Setting uniformScaling instead lets Fabric scale from
     * the anchor it already keeps, which is what every editor does.
     *
     * uniScaleKey is dropped along with it: Shift means "the other one", and
     * for a layer that cannot store a stretch there is no other one. */

    /* Typing straight into a caption. Written back when editing ends rather
     * than per keystroke: a rebuild mid-edit would tear the object out from
     * under the caret. What is on the canvas in a Layout is the raw text, so
     * this cannot swallow a "{{id}}" placeholder. */
    canvas.on("text:editing:exited", (opt) => {
      const obj = opt.target as (fabric.Textbox & { layerId?: string }) | undefined;
      if (obj?.layerId) void setLayerField(obj.layerId, "text", obj.text ?? "");
    });

    canvas.on("object:moving", (opt) => {
      transforming = true;
      guides = [];
      const target = opt.target;
      if (!target || (opt.e as MouseEvent | undefined)?.altKey) return;

      const moving = new Set(
        ((target as fabric.ActiveSelection).getObjects?.() ?? [target]).map(
          (o) => (o as { layerId?: string }).layerId,
        ),
      );
      const others = canvas!
        .getObjects()
        .filter((o) => !moving.has((o as { layerId?: string }).layerId))
        .map((o) => o.getBoundingRect());

      /* Fabric has already written the new left/top by now but not refreshed
       * the cached corner coordinates getBoundingRect reads, so without this
       * the box is one drag-step stale and the correction lands short — by
       * however far the pointer travelled in that step. */
      target.setCoords();

      // Threshold in screen pixels, converted here, so the pull feels the same
      // however far in or out the view is zoomed.
      const snap = snapBox(
        target.getBoundingRect(),
        [{ left: 0, top: 0, width: TILE_W, height: TILE_H }, ...others],
        SNAP_PX / canvas!.getZoom(),
      );
      if (!snap.dx && !snap.dy) return;

      target.set({ left: (target.left ?? 0) + snap.dx, top: (target.top ?? 0) + snap.dy });
      target.setCoords();
      guides = snap.guides;
    });

    const dropGuides = () => {
      if (!guides.length) return;
      guides = [];
      canvas?.requestRenderAll();
    };
    canvas.on("mouse:up", dropGuides);
    canvas.on("selection:cleared", dropGuides);

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
      // CSS pixels, not device pixels — same retina correction as GridCanvas,
      // or the sheet outline and every guide sit at 1/dpr scale off target.
      const dpr = canvas?.getRetinaScaling() ?? 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.round(vt[4]) + 0.5,
        Math.round(vt[5]) + 0.5,
        Math.round(TILE_W * vt[0]),
        Math.round(TILE_H * vt[3]),
      );

      /* One outline per selected layer. Fabric draws a single frame around a
       * multi-selection and nothing around its members, so without this a set
       * of three looks exactly like one big object and there is no way to tell
       * which layers are in it. Screen space, like every other guide here, so
       * it stays one pixel wide at any zoom and never reaches the export. */
      const picked = new Set(app.layoutSelection);
      if (picked.size > 1) {
        ctx.strokeStyle = "rgba(120, 220, 255, 0.9)";
        ctx.setLineDash([4, 3]);
        for (const obj of canvas!.getObjects()) {
          if (!picked.has((obj as { layerId?: string }).layerId ?? "")) continue;
          const b = obj.getBoundingRect();
          // Sat 3px outside the object: drawn flush, a cyan dash on a bright
          // picture is close to invisible, and the whole point is being seen.
          const pad = 3;
          ctx.strokeRect(
            Math.round(b.left * vt[0] + vt[4]) - pad + 0.5,
            Math.round(b.top * vt[3] + vt[5]) - pad + 0.5,
            Math.round(b.width * vt[0]) + pad * 2,
            Math.round(b.height * vt[3]) + pad * 2,
          );
        }
        ctx.setLineDash([]);
      }

      /* Alignment guides, drawn full-height/width so it is obvious what the
       * layer just lined up with. They exist only while a drag is in flight,
       * and only on this canvas — renderLayout uses a StaticCanvas that has no
       * after:render hook at all, so they can never reach a stamp. */
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
      ctx.restore();
    });

    /* Canvas selection -> model. getActiveObjects covers both cases: one
     * object, or every member of a rubber-band selection. */
    const picked = () => {
      if (rebuilding) return;
      const ids = canvas!
        .getActiveObjects()
        .map((o) => (o as { layerId?: string }).layerId)
        .filter((id): id is string => !!id);
      /* Anything already covered by the model's selection is this component
       * reporting back what it was told, not the user choosing something —
       * objectsFor turns a group id into its children's objects, since a group
       * owns no object of its own. Taking that at face value swapped the group
       * for its children the instant it was picked, so the highlighted row was
       * never the one clicked and renaming or dissolving hit a child.
       *
       * Membership, not a count: Fabric does not always report the whole set
       * back in one event, and one child arriving alone is the same story.
       * It also means a click on any member of a selected group keeps the
       * group selected, which is what makes dragging one part move the whole. */
      const covered = new Set(
        objectsFor(app.layoutSelection).map((o) => (o as { layerId?: string }).layerId),
      );
      if (ids.length && ids.every((id) => covered.has(id))) return;
      setLayoutSelection(ids);
    };
    const pickedThenRule = () => {
      picked();
      scalingRules();
    };
    canvas.on("selection:created", pickedThenRule);
    canvas.on("selection:updated", pickedThenRule);
    canvas.on("selection:cleared", () => {
      if (!rebuilding) setLayoutSelection([]);
    });

    /* A finished transform. One object writes itself back; a multi-selection
     * writes back every member, since Fabric moved all of them and each one's
     * own position and angle changed. */
    canvas.on("object:modified", (opt) => {
      // The release of a gesture Esc already took back — nothing to record.
      if (cancelled) {
        cancelled = false;
        return;
      }
      const target = opt.target as fabric.Object | undefined;
      if (!target) return;
      const members =
        (target as fabric.ActiveSelection).getObjects?.() ?? ([target] as fabric.Object[]);
      /* One run key for the whole gesture: a multi-selection writes back once
       * per member, and without this a single drag of a group of three cost
       * three undo steps — so one Ctrl+Z pulled the group apart on screen. */
      const gesture = `drag:${members.map((o) => (o as { layerId?: string }).layerId).join(",")}`;
      for (const obj of members) {
        const id = (obj as { layerId?: string }).layerId;
        if (id) void applyLayoutTransform(id, readBackLayout(obj), gesture);
      }
      // The gesture is over, so the run is too: a second drag moments later is
      // a second edit and has to cost its own undo step.
      endGesture();
    });

    const key = (e: KeyboardEvent, down: boolean) => {
      /* Esc mid-gesture takes the transform back, the reading GIMP and Krita
       * both use. Cheap here because the model is only written when the
       * gesture ends: cancelling is redrawing from the model and swallowing
       * the write-back the mouse release still fires. Registered in the
       * capture phase and stopped, because App's own Escape — close the
       * document — listens on the same window and must not win mid-drag. */
      if (down && e.key === "Escape" && transforming) {
        cancelled = true;
        transforming = false;
        guides = [];
        built = "";
        if (app.deps) void rebuild(app.deps);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.code !== "Space") return;
      if (isTyping(document.activeElement)) return;
      spaceHeld = down;
      host.style.cursor = down ? "grab" : "";
      if (down) e.preventDefault();
    };
    const onDown = (e: KeyboardEvent) => key(e, true);
    const onUp = (e: KeyboardEvent) => key(e, false);
    addEventListener("keydown", onDown, true);
    addEventListener("keyup", onUp, true);

    return () => {
      ro.disconnect();
      removeEventListener("keydown", onDown, true);
      removeEventListener("keyup", onUp, true);
      const dying = canvas;
      canvas = undefined;
      // Cleared, not left dangling: a Layout canvas comes and goes, and a
      // stale handle looks exactly like a live one.
      if (import.meta.env.DEV) Object.assign(window, { tesseraLayout: undefined });
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
  <!-- A fixed toolbar rather than buttons that come and go with the selection:
       a control with a permanent home can be found before it is needed, and
       greying out says "pick something first" better than absence does. -->
  <div class="tools">
    {#snippet tool(label: string, glyph: string, run: () => void, needs: number)}
      <button title={label} disabled={app.layoutSelection.length < needs} onclick={run}>
        {glyph}
      </button>
    {/snippet}
    {@render tool("Links ans Blatt", "⇤", () => align("left"), 1)}
    {@render tool("Horizontal zentrieren", "↔", () => align("centerX"), 1)}
    {@render tool("Rechts ans Blatt", "⇥", () => align("right"), 1)}
    <span class="gap"></span>
    {@render tool("Oben ans Blatt", "⤒", () => align("top"), 1)}
    {@render tool("Vertikal zentrieren", "↕", () => align("centerY"), 1)}
    {@render tool("Unten ans Blatt", "⤓", () => align("bottom"), 1)}
    <span class="gap"></span>
    <!-- Distribution needs a middle to spread; the maths refuses below three
         anyway, greying out just says so instead of doing nothing. -->
    {@render tool("Gleiche Abstände horizontal", "⇹", () => spread("x"), 3)}
    {@render tool("Gleiche Abstände vertikal", "⇳", () => spread("y"), 3)}
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
  .tools {
    position: absolute;
    left: 8px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 4px;
    border-radius: 4px;
    background: rgb(0 0 0 / 0.6);
  }
  .tools button {
    width: 28px;
    height: 26px;
    padding: 0;
    font: 14px/1 ui-sans-serif, system-ui, sans-serif;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #1b2228;
    color: #cfd6dc;
    cursor: pointer;
  }
  .tools button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .tools .gap {
    height: 6px;
  }
</style>
