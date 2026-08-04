<script lang="ts">
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import * as fabric from "fabric";
  import { TILE_H, TILE_W } from "./lib/bmp";
  import { buildBackground, buildLayerObject, type BuildCtx, type TaggedObject } from "./lib/fabricBuild";
  import {
    DEFAULT_IMAGE_SCALE,
    DEFAULT_SHAPE_SIZE,
    DEFAULT_TEXT_SIZE,
    isDetached,
    isGradient,
    newGradient,
    resetTransform,
    walkLayers,
    type Gradient,
    type Layer,
    type Paint,
    type ShapeKind,
    type TextLayer,
  } from "./lib/model";
  import { t } from "./lib/i18n.svelte";
  import {
    addImageLayer,
    addShapeLayer,
    addTextLayer,
    afterEdit,
    app,
    checkpointEdit,
    deleteLayer,
    detachLayer,
    canRedo,
    canUndo,
    editable,
    effective,
    groupLayers,
    moveIntoGroup,
    moveLayer,
    reattachLayer,
    redo,
    setMask,
    swapLayerImage,
    replaceTile,
    resetTile,
    setTileText,
    toggleHidden,
    undo,
  } from "./lib/state.svelte";

  const EDITOR_W = 640;
  const EDITOR_H = Math.round((EDITOR_W * TILE_H) / TILE_W);
  const BLENDS = ["source-over", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "hard-light", "difference", "hue", "saturation", "color", "luminosity"];

  const id = $derived(app.editing);
  const eff = $derived(effective(id));
  const layer = $derived(app.selectedLayer ? editable(id, app.selectedLayer) : undefined);
  const detached = $derived(!!layer && isDetached(app.manifest, id, layer.id));
  const shared = $derived(!!layer && app.manifest.shared.some((s) => s.id === layer.id));

  let canvasEl: HTMLCanvasElement;
  let fc: fabric.Canvas | undefined;

  // The Fabric canvas lives for as long as canvasEl does — created once,
  // disposed once. Content rebuilds below reuse it instead of recreating it,
  // so dragging a layer around doesn't blank the stage every frame.
  $effect(() => {
    if (!canvasEl) return;
    const canvas = new fabric.Canvas(canvasEl, { width: EDITOR_W, height: EDITOR_H });

    canvas.on("selection:created", (e) => { if (!syncingFromList) syncSelectionFromCanvas(e); });
    canvas.on("selection:updated", (e) => { if (!syncingFromList) syncSelectionFromCanvas(e); });
    canvas.on("selection:cleared", () => { if (!syncingFromList) selected = []; });
    canvas.on("before:transform", (e) => {
      checkpointEdit();
      captureDragStart(e.transform?.target);
    });
    canvas.on("object:moving", onObjectMoving);
    canvas.on("object:modified", onObjectModified);

    fc = canvas;
    return () => {
      fc = undefined;
      canvas.dispose();
    };
  });

  function syncSelectionFromCanvas(e: { selected?: fabric.Object[] }) {
    const ids = (e.selected ?? []).map((o) => (o as TaggedObject).layerId).filter(Boolean);
    if (!ids.length) return;
    selected = ids;
    app.selectedLayer = ids[ids.length - 1];
  }

  /** A group layer's x/y is a *displacement* on top of its children's own
   *  absolute coordinates (see fabricBuild.ts), not an absolute position —
   *  writing back the dragged object's absolute centre would work for a plain
   *  layer but fling a group off to wherever its auto-computed bounding-box
   *  centre happens to sit. Tracking the centre at drag-start and writing back
   *  only the *delta* is correct for both cases, and matches how the old
   *  pointer-based drag worked before this was Fabric's job. */
  let dragStart = new Map<string, { x: number; y: number }>();

  /* A mask is an `absolutePositioned` clipPath, which means it is pinned to
   * canvas coordinates and does NOT follow its target while that target is
   * being dragged — the layer slides out from under its own mask until the
   * drag ends and the scene rebuilds. These carry each clip's position at
   * drag-start plus the dragged target's, so object:moving can shift the
   * clips by the same live delta and keep mask and layer glued together. */
  let dragOrigin: { x: number; y: number } | null = null;
  let movingClips: { clip: NonNullable<fabric.Object["clipPath"]>; left: number; top: number }[] = [];
  /* Objects whose cached bitmap already has the mask baked in. Fabric's
   * cacheProperties list covers fill, stroke, size and so on, but not left/top
   * — moving an object therefore reuses its cache and slides the clipped
   * result along with it, so the mask appeared to travel with the layer until
   * the drag ended and the scene rebuilt. Marking them dirty each frame forces
   * the clip to be re-applied at the object's new position, which is what
   * makes the layer visibly move *through* a stationary mask. */
  let clippedObjects: fabric.Object[] = [];

  function collectClipped(o: fabric.Object) {
    if (o.clipPath?.absolutePositioned) clippedObjects.push(o);
    if (o instanceof fabric.Group) for (const kid of o.getObjects()) collectClipped(kid);
  }

  /** Only clips *inside* a dragged group travel with it. render.ts places a
   *  mask from the mask layer's own x/y, independent of what it masks, so
   *  dragging a masked layer directly must leave its mask where it is and slide
   *  the layer through it — only paintGroup moves a group's whole flattened
   *  content, masks included. Collecting the dragged object's own clip made a
   *  masked image drag its mask along, which the tile preview never did. */
  function collectClips(o: fabric.Object) {
    if (!(o instanceof fabric.Group)) return;
    for (const kid of o.getObjects()) {
      const clip = kid.clipPath;
      if (clip?.absolutePositioned) movingClips.push({ clip, left: clip.left ?? 0, top: clip.top ?? 0 });
      collectClips(kid);
    }
  }

  function captureDragStart(target: fabric.Object | undefined) {
    dragStart.clear();
    movingClips = [];
    clippedObjects = [];
    dragOrigin = null;
    if (!target) return;
    dragOrigin = target.getCenterPoint();
    const objs = target instanceof fabric.ActiveSelection ? target.getObjects() : [target];
    for (const o of objs) {
      const lid = (o as TaggedObject).layerId;
      if (lid) dragStart.set(lid, o.getCenterPoint());
      collectClips(o);
      collectClipped(o);
    }
  }

  function onObjectMoving(e: { target?: fabric.Object }) {
    if (!e.target || !dragOrigin) return;
    if (movingClips.length) {
      const p = e.target.getCenterPoint();
      const dx = p.x - dragOrigin.x;
      const dy = p.y - dragOrigin.y;
      for (const c of movingClips) c.clip.set({ left: c.left + dx, top: c.top + dy });
    }
    // The enclosing group caches the flattened result, so it has to be
    // reflowed too, not just the clipped child inside it.
    for (const o of clippedObjects) {
      o.dirty = true;
      for (let p = o.group; p; p = p.group) p.dirty = true;
    }
  }

  /** Only position is synced back for now — resize/rotate handles are off
   *  (buildLayerObject sets hasControls:false), so a modified event is always
   *  a drag. Writing scale/angle back too is a later step, once undo and the
   *  shared-vs-detached editing story around it are worked out. */
  function onObjectModified(e: { target?: fabric.Object }) {
    const target = e.target;
    if (!target) return;
    const objs = target instanceof fabric.ActiveSelection ? target.getObjects() : [target];
    for (const o of objs) {
      const lid = (o as TaggedObject).layerId;
      const l = lid && editable(id, lid);
      const start = lid && dragStart.get(lid);
      if (!l || l.locked || !start) continue;
      const c = o.getCenterPoint();
      l.x += (c.x - start.x) / EDITOR_W;
      l.y += (c.y - start.y) / EDITOR_H;
      afterEdit(id, lid);
    }
    dragStart.clear();
    movingClips = [];
    clippedObjects = [];
    dragOrigin = null;
  }

  // `eff` is a freshly computed object on every read, so effects elsewhere
  // touching unrelated app state can make Svelte re-run this $effect with
  // content that hasn't actually changed. Rebuilding on every such no-op
  // re-run would restart every in-flight image load for no reason.
  let lastKey = "";

  $effect(() => {
    if (!fc || !eff) return;
    const key = `${id}:${JSON.stringify(eff)}`;
    if (key === lastKey) return;
    lastKey = key;
    let cancelled = false;
    const canvas = fc;
    const ctx: BuildCtx = { dir: app.dir, eff, tileId: id, W: EDITOR_W, H: EDITOR_H, interactive: true };

    (async () => {
      // Built fully off-canvas first so the previous frame stays visible the
      // whole time images are (re)loading — swapped in only once, in one
      // synchronous batch, instead of appearing one-by-one as they resolve.
      const built: fabric.Object[] = [];
      try {
        built.push(await buildBackground(app.dir, id, eff, EDITOR_W, EDITOR_H));
      } catch (e) {
        console.error("Fabric: background failed", e);
      }
      if (cancelled) return;
      for (const l of eff.layers) {
        if (cancelled) return; // tile switched or editor closed mid-load
        if (l.hidden) continue;
        try {
          const obj = await buildLayerObject(l, ctx);
          if (obj) built.push(obj);
        } catch (e) {
          console.error(`Fabric: layer "${l.name ?? l.kind}" failed`, e);
        }
      }
      if (cancelled || canvas !== fc) return;
      // Every edit rebuilds the scene from the model, which throws the old
      // objects — and with them the selection — away. Re-selecting the same
      // layers keeps the highlight up until another layer is picked, instead
      // of it vanishing the moment a drag is released. The ids have to be
      // captured *before* the discard: that fires selection:cleared, whose
      // handler empties `selected`, so syncCanvasSelection would otherwise
      // find nothing left to restore.
      const keep = selected;
      canvas.discardActiveObject();
      canvas.remove(...canvas.getObjects());
      canvas.add(...built);
      selected = keep;
      syncCanvasSelection();
      canvas.requestRenderAll();
    })();

    return () => {
      cancelled = true;
    };
  });

  const commit = () => layer && afterEdit(id, layer.id);

  function resetLayer() {
    if (!layer) return;
    checkpointEdit();
    resetTransform(layer);
    commit();
  }

  function toggleLockFor(lid: string) {
    checkpointEdit();
    const l = editable(id, lid);
    if (!l) return;
    l.locked = !l.locked;
    afterEdit(id, lid);
  }

  function toggleVisibleFor(lid: string) {
    checkpointEdit();
    const l = editable(id, lid);
    if (!l) return;
    l.hidden = !l.hidden;
    afterEdit(id, lid);
  }

  function renameFor(lid: string, name: string) {
    const l = editable(id, lid);
    if (l) l.name = name;
  }

  let renamingId = $state("");

  function focusOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  /* Ctrl/Cmd-click extends the selection; a plain click replaces it. Everything
   * selected drags together in the preview, which is a pure view concern — no
   * relationship is written into the manifest, unlike masking or grouping. */
  let selected = $state<string[]>([]);

  function pickClick(e: MouseEvent, lid: string) {
    if (e.ctrlKey || e.metaKey) {
      selected = selected.includes(lid) ? selected.filter((x) => x !== lid) : [...selected, lid];
    } else {
      selected = [lid];
    }
    // A ctrl-click that just *removed* lid from the selection must not make it
    // the panel's edit target — it fell to whatever's now last in `selected`,
    // matching how a plain click already picks the one just clicked.
    app.selectedLayer = selected.includes(lid) ? lid : selected[selected.length - 1];
    syncCanvasSelection();
  }

  /** Mirrors `selected` onto the Fabric canvas so picking a layer in the list
   *  highlights it on the stage too. One-way (list → canvas) only — the
   *  reverse is handled directly by syncSelectionFromCanvas, not by watching
   *  `selected` reactively, which would ping-pong the two in a loop. */
  /** Searches into groups, so picking a nested layer in the list highlights it
   *  on the stage instead of silently matching nothing. */
  function findObject(layerId: string, pool: fabric.Object[]): fabric.Object | undefined {
    for (const o of pool) {
      if ((o as TaggedObject).layerId === layerId) return o;
      if (o instanceof fabric.Group) {
        const hit = findObject(layerId, o.getObjects());
        if (hit) return hit;
      }
    }
    return undefined;
  }

  /** Set while this function is driving the canvas, so the selection events it
   *  provokes (discardActiveObject fires "selection:cleared", setActiveObject
   *  fires "selection:created"/"updated") don't loop back into `selected` —
   *  they used to, and for a nested multi-select that was destructive: Fabric
   *  can't build one ActiveSelection spanning two children of the same group
   *  (ActiveSelection cannot span in and out of a group), so a nested hit is
   *  selected on its own instead. That single-object reselect then round-tripped
   *  through the "selected"/"updated" handler and silently collapsed the
   *  ctrl-click's multi-select back down to one layer. */
  let syncingFromList = false;

  function syncCanvasSelection() {
    if (!fc) return;
    syncingFromList = true;
    try {
      const objs = selected.map((sid) => findObject(sid, fc!.getObjects())).filter((o): o is fabric.Object => !!o);
      fc.discardActiveObject();
      const flat = objs.filter((o) => !o.group);
      if (flat.length > 1) fc.setActiveObject(new fabric.ActiveSelection(flat, { canvas: fc }));
      else if (objs.length >= 1) fc.setActiveObject(objs[0]);
      fc.requestRenderAll();
    } finally {
      syncingFromList = false;
    }
  }

  /* Selecting a layer that is gone (deleted, or grouped away) would leave the
   * side panel editing a ghost. */
  $effect(() => {
    const live = new Set([...walkLayers(eff.layers)].map((l) => l.id));
    if (selected.some((sid) => !live.has(sid))) selected = selected.filter((sid) => live.has(sid));
  });

  function kindLabel(l: { kind: string; shape?: ShapeKind }) {
    if (l.kind === "image") return t("layer.kindImage");
    if (l.kind === "text") return t("layer.kindText");
    if (l.kind === "group") return t("layer.kindGroup");
    return t(`shape.${l.shape}`);
  }

  /* Dropping a layer on a group moves it in; dropping it on a plain layer wraps
   * both in a new group, which is how Photoshop-style grouping is usually
   * discovered without hunting for a menu. */
  let dragLayerId = $state("");

  function onLayerDrop(targetId: string) {
    const source = dragLayerId;
    dragLayerId = "";
    if (!source || source === targetId) return;
    const target = editable(id, targetId);
    if (target?.kind === "group") moveIntoGroup(id, source, targetId);
    else groupLayers(id, [source, targetId]);
  }

  /** Lifts a dropped layer out of its group. Ignored for a layer already at
   *  top level: moveIntoGroup re-appends unconditionally, so letting that
   *  through would silently restack a layer that was only dropped slightly
   *  wide of its row. */
  function onDropOutOfGroup() {
    const source = dragLayerId;
    dragLayerId = "";
    if (source && !eff.layers.some((l) => l.id === source)) moveIntoGroup(id, source, null);
  }

  /* Anything with a silhouette can be a mask source: a shape clips via its own
   * Path2D; text and images have no Path2D, so they clip via a destination-in
   * pass over their glyphs/alpha instead (see paintLayer in render.ts). */
  const maskChoices = $derived(
    [...walkLayers(eff.layers)].filter((l) => l.kind === "shape" || l.kind === "text" || l.kind === "image"),
  );

  function flip(axis: "flipX" | "flipY") {
    if (!layer || layer.kind !== "image") return;
    checkpointEdit();
    layer[axis] = !layer[axis];
    commit();
  }


  function setGlow(value: number) {
    if (!layer) return;
    if (value > 0 && !layer.glowColor) {
      layer.glowColor = "#ffffff";
      layer.glowOpacity = 1;
    }
    layer.glow = value;
  }

  function resetGlow() {
    if (!layer) return;
    checkpointEdit();
    layer.glow = 0;
    commit();
  }

  function resetSize() {
    if (!layer) return;
    checkpointEdit();
    if (layer.kind === "image") layer.scale = DEFAULT_IMAGE_SCALE;
    else if (layer.kind === "shape") {
      layer.w = DEFAULT_SHAPE_SIZE;
      layer.h = DEFAULT_SHAPE_SIZE;
    } else if (layer.kind === "text") layer.size = DEFAULT_TEXT_SIZE;
    commit();
  }

  function resetField(
    field: "rotation" | "opacity" | "strokeWidth" | "shadow" | "cornerRadius" | "sides" | "borderWidth",
    value: number,
  ) {
    if (!layer) return;
    checkpointEdit();
    if (field === "strokeWidth" || field === "shadow") {
      if (layer.kind === "text") layer[field] = value;
    } else if (field === "cornerRadius" || field === "sides" || field === "borderWidth") {
      if (layer.kind === "shape") layer[field] = value;
    } else {
      layer[field] = value;
    }
    commit();
  }

  async function pickImageLayer(asShared: boolean) {
    const picked = await openDialog({
      filters: [{ name: t("image.pick"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg"] }],
    });
    if (typeof picked === "string") await addImageLayer(picked, asShared);
  }

  async function pickBase() {
    const picked = await openDialog({
      filters: [{ name: t("image.pick"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
    });
    if (typeof picked === "string") await replaceTile(id, picked);
  }

  async function swapImage() {
    if (!layer) return;
    const picked = await openDialog({
      filters: [{ name: t("image.pick"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg"] }],
    });
    if (typeof picked === "string") await swapLayerImage(id, layer.id, picked);
  }
</script>

{#snippet resetIcon()}
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M13.5 8A5.5 5.5 0 1 1 9.7 2.68a.75.75 0 1 1-.4 1.446A4 4 0 1 0 12 8a.75.75 0 0 1 1.5 0Z" />
    <path d="M9 1.75a.75.75 0 0 1 .75-.75H12.5a.75.75 0 0 1 .75.75V4.5a.75.75 0 0 1-1.5 0V3.56L10.28 5.03a.75.75 0 1 1-1.06-1.06L10.69 2.5H9.75A.75.75 0 0 1 9 1.75Z" />
  </svg>
{/snippet}

{#snippet sectionTitle(text: string)}
  <h4 class="section-title">{text}</h4>
{/snippet}

{#snippet numSlider(
  value: number,
  oninput: (v: number) => void,
  reset: () => void,
  min: number,
  max: number,
  step: number,
  unit?: string,
  disabled?: boolean,
)}
  <span class="slider">
    <input type="range" {min} {max} {step} {value} {disabled} oninput={(e) => oninput(+e.currentTarget.value)} onchange={commit} />
    <!-- A number input only enforces min/max on form validation, so typing a
         value past the slider's range goes straight into the model. One stray
         digit in a size field produced a shape ~100x the tile, which Fabric
         then rendered through a capped, heavily downscaled cache — it looked
         like a blur bug. The upper bound is applied per keystroke because no
         value above it is ever meaningful; the lower one only on commit, since
         a half-typed "0.0" would otherwise be snapped away mid-entry. -->
    <input
      type="number"
      class="num"
      {min}
      {max}
      {step}
      {value}
      {disabled}
      oninput={(e) => oninput(Math.min(+e.currentTarget.value || 0, max))}
      onchange={(e) => { oninput(Math.min(Math.max(+e.currentTarget.value || 0, min), max)); commit(); }}
    />
    {#if unit}<span class="unit">{unit}</span>{/if}
    <button class="slider-reset" onclick={reset} title={t("field.resetOne")}>{@render resetIcon()}</button>
  </span>
{/snippet}

{#snippet imageIcon()}
  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" />
    <circle cx="5" cy="6" r="1.3" fill="currentColor" />
    <path d="M2.5 12 6.5 8l2.5 2.5 2-2 2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" />
  </svg>
{/snippet}

{#snippet textIcon()}
  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
    <path d="M2.5 3.5h11M8 3.5v9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
  </svg>
{/snippet}

{#snippet rectIcon()}
  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
    <rect x="2" y="4" width="12" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" />
  </svg>
{/snippet}

{#snippet ellipseIcon()}
  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
    <ellipse cx="8" cy="8" rx="6" ry="4.5" fill="none" stroke="currentColor" stroke-width="1.3" />
  </svg>
{/snippet}

{#snippet polygonIcon()}
  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
    <path d="M8 1.5 14 5v6l-6 3.5L2 11V5Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
  </svg>
{/snippet}

{#snippet alignIcon(align: "left" | "center" | "right")}
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    {#if align === "left"}
      <path d="M1.5 3h13M1.5 6.5h8M1.5 10h13M1.5 13.5h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    {:else if align === "center"}
      <path d="M1.5 3h13M4 6.5h8M1.5 10h13M4 13.5h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    {:else}
      <path d="M1.5 3h13M6.5 6.5h8M1.5 10h13M6.5 13.5h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    {/if}
  </svg>
{/snippet}

{#snippet eyeIcon(open: boolean)}
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    {#if open}
      <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z" fill="none" stroke="currentColor" stroke-width="1.3" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    {:else}
      <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z" fill="none" stroke="currentColor" stroke-width="1.3" />
      <path d="M2 2l12 12" stroke="currentColor" stroke-width="1.3" />
    {/if}
  </svg>
{/snippet}

{#snippet paintEditor(get: () => Paint, set: (v: Paint) => void, label: string)}
  <div class="row name-row">
    {#if isGradient(get())}
      <label class="grow">{label}
        <span class="slider">
          <input
            type="color"
            value={(get() as Gradient).from}
            oninput={(e) => { (get() as Gradient).from = e.currentTarget.value; }}
            onchange={commit}
          />
          <input
            type="color"
            value={(get() as Gradient).to}
            oninput={(e) => { (get() as Gradient).to = e.currentTarget.value; }}
            onchange={commit}
          />
        </span>
      </label>
    {:else}
      <label class="grow">{label}
        <input type="color" value={get()} oninput={(e) => set(e.currentTarget.value)} onchange={commit} />
      </label>
    {/if}
    <button
      class="icon-toggle"
      class:on={isGradient(get())}
      onclick={() => { checkpointEdit(); set(isGradient(get()) ? "#ffffff" : newGradient()); commit(); }}
      title={t("field.gradient")}
    >
      {@render gradientIcon()}
    </button>
  </div>
  {#if isGradient(get())}
    <label>{t("field.angle")}
      {@render numSlider(
        (get() as Gradient).angle,
        (v) => { (get() as Gradient).angle = v; },
        () => { checkpointEdit(); (get() as Gradient).angle = 0; commit(); },
        0, 360, 1, "°", !!(get() as Gradient).radial,
      )}
    </label>
    <label>{t("field.radial")}
      <input
        type="checkbox"
        checked={!!(get() as Gradient).radial}
        onchange={(e) => { checkpointEdit(); (get() as Gradient).radial = e.currentTarget.checked; commit(); }}
      />
    </label>
    {#if (get() as Gradient).radial}
      <label>{t("field.radius")}
        {@render numSlider(
          (get() as Gradient).radius ?? 1,
          (v) => { (get() as Gradient).radius = v; },
          () => { checkpointEdit(); (get() as Gradient).radius = 1; commit(); },
          0.2, 3, 0.05,
        )}
      </label>
    {/if}
  {/if}
{/snippet}

{#snippet glowSection()}
  {@render sectionTitle(t("section.glow"))}
  <label>{t("field.size")}
    {@render numSlider(layer!.glow ?? 0, setGlow, resetGlow, 0, 0.08, 0.002)}
  </label>
  {#if layer!.glow}
    {@render paintEditor(() => layer!.glowColor ?? "#ffffff", (v: Paint) => (layer!.glowColor = v), t("field.color"))}
    <label>{t("field.opacity")}
      {@render numSlider(
        layer!.glowOpacity ?? 1,
        (v) => (layer!.glowOpacity = v),
        () => { checkpointEdit(); layer!.glowOpacity = 1; commit(); },
        0, 1, 0.01,
      )}
    </label>
  {/if}
{/snippet}

{#snippet maskSection()}
  {@render sectionTitle(t("section.mask"))}
  <label>{t("field.mask")}
    <select value={layer!.maskId ?? ""} onchange={(e) => setMask(id, layer!.id, e.currentTarget.value)}>
      <option value="">{t("field.maskNone")}</option>
      {#each maskChoices.filter((s) => s.id !== layer!.id) as s}
        <option value={s.id}>{s.name || kindLabel(s)}</option>
      {/each}
    </select>
  </label>
{/snippet}

{#snippet effectsSection()}
  {@render sectionTitle(t("section.effects"))}
  <label>{t("field.blend")}
    <select bind:value={layer!.blend} onchange={commit}>
      {#each BLENDS as b}<option value={b}>{b}</option>{/each}
    </select>
  </label>
{/snippet}

{#snippet transformSection()}
  {@render sectionTitle(t("section.transform"))}
  <label>{t("field.rotation")}
    {@render numSlider(layer!.rotation, (v) => (layer!.rotation = v), () => resetField("rotation", 0), -180, 180, 1)}
  </label>
  <label>{t("field.opacity")}
    {@render numSlider(layer!.opacity, (v) => (layer!.opacity = v), () => resetField("opacity", 1), 0, 1, 0.01)}
  </label>
  {#if layer!.kind === "image"}
    <label>{t("layer.flipX")}
      <input type="checkbox" checked={!!layer!.flipX} onchange={() => flip("flipX")} />
    </label>
    <label>{t("layer.flipY")}
      <input type="checkbox" checked={!!layer!.flipY} onchange={() => flip("flipY")} />
    </label>
  {/if}
{/snippet}

{#snippet undoIcon()}
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M4 4.5H10.5a3.5 3.5 0 0 1 0 7H6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <path d="M6.5 2 4 4.5l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
{/snippet}

{#snippet redoIcon()}
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M12 4.5H5.5a3.5 3.5 0 0 0 0 7H10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <path d="M9.5 2 12 4.5 9.5 7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
{/snippet}

{#snippet groupIcon()}
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
  </svg>
{/snippet}

{#snippet leaveGroupIcon()}
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M9.5 3.5H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h5.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    <path d="M8 8h6M11.5 5.5 14 8l-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
{/snippet}

<!-- Recursive so a group renders its children with the same row markup; the
     reverse puts the top-most layer at the top of the list, as in every other
     editor, since layers paint back to front. `nested` is true for a group's
     children, which are the only rows that can be lifted out of a group. -->
{#snippet layerList(layers: Layer[], nested: boolean)}
  <ul class="layers">
    {#each [...layers].reverse() as l (l.id)}
      <li
        class:sel={l.id === app.selectedLayer}
        class:picked={selected.includes(l.id)}
        draggable={renamingId !== l.id}
        ondragstart={() => (dragLayerId = l.id)}
        ondragover={(e) => e.preventDefault()}
        ondrop={(e) => { e.stopPropagation(); onLayerDrop(l.id); }}
      >
        {#if l.kind === "group"}<span class="folder">{@render groupIcon()}</span>{/if}
        {#if renamingId === l.id}
          <input
            class="pick"
            value={l.name ?? ""}
            placeholder={kindLabel(l)}
            use:focusOnMount
            onblur={(e) => { renameFor(l.id, e.currentTarget.value); afterEdit(id, l.id); renamingId = ""; }}
            onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          />
        {:else}
          <button
            class="pick"
            onclick={(e) => pickClick(e, l.id)}
            ondblclick={() => { checkpointEdit(); renamingId = l.id; }}
          >{l.name || kindLabel(l)}</button>
        {/if}
        {#if app.manifest.shared.some((s) => s.id === l.id)}
          <span class="scope" class:local={isDetached(app.manifest, id, l.id)}>
            {isDetached(app.manifest, id, l.id) ? t("layer.scope.local") : t("layer.scope.all")}
          </span>
        {/if}
        <button class="step" onclick={() => moveLayer(id, l.id, -1)} title={t("layer.down")}>↓</button>
        <button class="step" onclick={() => moveLayer(id, l.id, 1)} title={t("layer.up")}>↑</button>
        <button class="step" onclick={() => toggleVisibleFor(l.id)} title={l.hidden ? t("layer.show") : t("layer.hide")}>
          {@render eyeIcon(!l.hidden)}
        </button>
        <button
          class="step"
          class:on={!!l.locked}
          onclick={() => toggleLockFor(l.id)}
          title={l.locked ? t("layer.unlock") : t("layer.lock")}
        >
          {#if l.locked}
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5A1.5 1.5 0 0 1 12.5 15h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm1.5 0h5V5a2.5 2.5 0 0 0-5 0v2Z" />
            </svg>
          {:else}
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M11.5 7V5a2.5 2.5 0 0 0-4.975-.3.75.75 0 1 1-1.487-.2A4 4 0 0 1 13 5v2h-.5a1.5 1.5 0 0 1 2 1.5v5A1.5 1.5 0 0 1 12.5 15h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7h8Z" />
            </svg>
          {/if}
        </button>
        {#if nested}
          <button
            class="step"
            onclick={() => moveIntoGroup(id, l.id, null)}
            disabled={!!l.locked}
            title={t("layer.leaveGroup")}
          >{@render leaveGroupIcon()}</button>
        {/if}
        <button
          class="step danger"
          onclick={() => deleteLayer(id, l.id)}
          disabled={!!l.locked}
          title={l.locked ? t("layer.deleteLocked") : l.kind === "group" ? t("layer.ungroup") : t("layer.delete")}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M6 2h4a1 1 0 0 1 1 1v1h3v1.5H2V4h3V3a1 1 0 0 1 1-1Zm-1.5 4h7l-.6 8.1a1 1 0 0 1-1 .9H6.1a1 1 0 0 1-1-.9L4.5 6Z" />
          </svg>
        </button>
      </li>
      {#if l.kind === "group" && l.children.length}
        <li class="nest">{@render layerList(l.children, true)}</li>
      {/if}
    {/each}
  </ul>
{/snippet}

{#snippet gradientIcon()}
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <defs>
      <linearGradient id="g-icon" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="currentColor" stop-opacity="0.15" />
        <stop offset="1" stop-color="currentColor" />
      </linearGradient>
    </defs>
    <rect x="1" y="4" width="14" height="8" rx="2" fill="url(#g-icon)" />
  </svg>
{/snippet}

<div class="editor">
  <div class="stage-col">
    <canvas bind:this={canvasEl} width={EDITOR_W} height={EDITOR_H}></canvas>
  </div>

  <div class="layers-col">
    <div class="layers-head">
      {@render sectionTitle(t("section.layers"))}
      <button
        class="step"
        disabled={selected.length < 2}
        onclick={async () => { await groupLayers(id, selected); selected = [app.selectedLayer]; }}
        title={t("layer.group")}
      >{@render groupIcon()}</button>
    </div>
    {@render layerList(eff.layers, false)}
    <!-- Catches a row dropped past the end of the list: rows stopPropagation on
         their own drop, so anything arriving here was aimed at open space, which
         reads as "out of whatever group it was in". -->
    <div
      class="drop-out"
      class:active={!!dragLayerId}
      ondragover={(e) => e.preventDefault()}
      ondrop={onDropOutOfGroup}
      role="presentation"
    >{t("layer.leaveGroup")}</div>
  </div>

  <div class="panel">
    {@render sectionTitle(t("section.tools"))}
    <div class="row">
      <button class="step" onclick={undo} disabled={!canUndo()} title={t("edit.undo")}>{@render undoIcon()}</button>
      <button class="step" onclick={redo} disabled={!canRedo()} title={t("edit.redo")}>{@render redoIcon()}</button>
    </div>
    <div class="row">
      <button onclick={pickBase}>{t("tile.base")}</button>
      <button onclick={() => resetTile(id)}>{t("tile.reset")}</button>
      <button onclick={() => toggleHidden(id)}>
        {app.manifest.hidden.includes(id) ? t("tile.show") : t("tile.hide")}
      </button>
      <button onclick={() => (app.editing = "")}>{t("tile.closeEditor")}</button>
    </div>

    {@render sectionTitle(t("layer.addSingle"))}
    <div class="row row-5">
      <button onclick={() => pickImageLayer(false)} title={t("layer.kindImage")}>{@render imageIcon()}</button>
      <button onclick={() => addTextLayer(false)} title={t("layer.kindText")}>{@render textIcon()}</button>
      <button onclick={() => addShapeLayer("rect", false)} title={t("shape.rect")}>{@render rectIcon()}</button>
      <button onclick={() => addShapeLayer("ellipse", false)} title={t("shape.ellipse")}>{@render ellipseIcon()}</button>
      <button onclick={() => addShapeLayer("polygon", false)} title={t("shape.polygon")}>{@render polygonIcon()}</button>
    </div>

    {@render sectionTitle(t("layer.addAll"))}
    <div class="row row-5">
      <button onclick={() => pickImageLayer(true)} title={t("layer.kindImage")}>{@render imageIcon()}</button>
      <button onclick={() => addTextLayer(true)} title={t("layer.kindText")}>{@render textIcon()}</button>
      <button onclick={() => addShapeLayer("rect", true)} title={t("shape.rect")}>{@render rectIcon()}</button>
      <button onclick={() => addShapeLayer("ellipse", true)} title={t("shape.ellipse")}>{@render ellipseIcon()}</button>
      <button onclick={() => addShapeLayer("polygon", true)} title={t("shape.polygon")}>{@render polygonIcon()}</button>
    </div>

    {#if layer}
      <div class="fields">
        <div class="row">
          <button class:full={layer.kind !== "image"} onclick={resetLayer} title={t("layer.resetAll")}>{t("layer.resetAll")}</button>
          {#if layer.kind === "image"}
            <button onclick={swapImage} title={t("layer.swapImage")}>{t("layer.swapImage")}</button>
          {/if}
        </div>

        {#if shared}
          {#if detached}
            <button onclick={() => reattachLayer(id, layer.id)}>{t("layer.reattach")}</button>
          {:else}
            <button onclick={() => detachLayer(id, layer.id)}>{t("layer.detach")}</button>
          {/if}
        {/if}

        {#if layer.kind === "text"}
          {@render sectionTitle(t("section.content"))}
          <!-- A textarea rather than an input so a caption can hold line
               breaks. Enter commits, as it did when this was an input;
               Shift+Enter is what inserts an actual break. -->
          <label>{t("field.text")}
            <textarea
              class="text-field"
              rows="2"
              value={app.manifest.tiles[id]?.text[layer.id] ?? (layer as TextLayer).text}
              placeholder={t("layer.kindText")}
              title={t("field.textHint")}
              onfocus={checkpointEdit}
              oninput={(e) => setTileText(id, layer.id, e.currentTarget.value)}
              onkeydown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); } }}
              onchange={commit}
            ></textarea>
          </label>
          <label>{t("field.font")}
            <select bind:value={layer.font} onchange={commit}>
              {#each app.fonts as font}<option value={font}>{font}</option>{/each}
            </select>
          </label>
          <label>{t("field.align")}
            <div class="row row-3">
              <button class:on={(layer.align ?? "center") === "left"} onclick={() => { checkpointEdit(); layer.align = "left"; commit(); }} title={t("align.left")}>{@render alignIcon("left")}</button>
              <button class:on={(layer.align ?? "center") === "center"} onclick={() => { checkpointEdit(); layer.align = "center"; commit(); }} title={t("align.center")}>{@render alignIcon("center")}</button>
              <button class:on={(layer.align ?? "center") === "right"} onclick={() => { checkpointEdit(); layer.align = "right"; commit(); }} title={t("align.right")}>{@render alignIcon("right")}</button>
            </div>
          </label>
          <label>{t("field.style")}
            <div class="row">
              <button
                class:on={!!layer.bold}
                onclick={() => { checkpointEdit(); layer.bold = !layer.bold; commit(); }}
                title={t("style.bold")}
              ><b>B</b></button>
              <button
                class:on={!!layer.italic}
                onclick={() => { checkpointEdit(); layer.italic = !layer.italic; commit(); }}
                title={t("style.italic")}
              ><i>I</i></button>
            </div>
          </label>

          {@render sectionTitle(t("section.transform"))}
          <label>{t("field.size")}
            {@render numSlider(layer.size, (v) => (layer.size = v), resetSize, 0.02, 0.4, 0.005)}
          </label>
          {@render transformSection()}

          {@render sectionTitle(t("section.color"))}
          {@render paintEditor(() => layer.color, (v: Paint) => (layer.color = v), t("field.color"))}

          {@render sectionTitle(t("section.outline"))}
          <label>{t("field.width")}
            {@render numSlider(layer.strokeWidth, (v) => (layer.strokeWidth = v), () => resetField("strokeWidth", 0), 0, 0.03, 0.001)}
          </label>
          <label>{t("field.color")}<input type="color" bind:value={layer.strokeColor} onchange={commit} /></label>

          {@render sectionTitle(t("section.shadow"))}
          <label>{t("field.size")}
            {@render numSlider(layer.shadow, (v) => (layer.shadow = v), () => resetField("shadow", 0), 0, 0.1, 0.002)}
          </label>
          <label>{t("field.color")}<input type="color" bind:value={layer.shadowColor} onchange={commit} /></label>

          {@render maskSection()}
          {@render glowSection()}
          {@render effectsSection()}
        {:else if layer.kind === "image"}
          {@render sectionTitle(t("section.transform"))}
          <label>{t("field.size")}
            {@render numSlider(layer.scale, (v) => (layer.scale = v), resetSize, 0.02, 2, 0.01)}
          </label>
          {@render transformSection()}

          {@render maskSection()}
          {@render glowSection()}
          {@render effectsSection()}
        {:else if layer.kind === "group"}
          {@render transformSection()}
          {@render effectsSection()}
        {:else if layer.kind === "shape"}
          {@render sectionTitle(t("section.shape"))}
          <label>{t("field.type")}
            <select bind:value={layer.shape} onchange={commit}>
              <option value="rect">{t("shape.rect")}</option>
              <option value="ellipse">{t("shape.ellipse")}</option>
              <option value="polygon">{t("shape.polygon")}</option>
            </select>
          </label>
          <label>{t("field.width")}
            {@render numSlider(layer.w, (v) => (layer.w = v), resetSize, 0.02, 1, 0.01)}
          </label>
          <label>{t("field.height")}
            {@render numSlider(layer.h, (v) => (layer.h = v), resetSize, 0.02, 1, 0.01)}
          </label>
          {#if layer.shape === "rect"}
            <label>{t("field.cornerRadius")}
              {@render numSlider(layer.cornerRadius, (v) => (layer.cornerRadius = v), () => resetField("cornerRadius", 0), 0, 0.5, 0.01)}
            </label>
          {:else if layer.shape === "polygon"}
            <label>{t("field.sides")}
              {@render numSlider(layer.sides, (v) => (layer.sides = v), () => resetField("sides", 6), 3, 12, 1)}
            </label>
          {/if}

          {@render transformSection()}

          {@render sectionTitle(t("section.color"))}
          {@render paintEditor(() => layer.fill, (v: Paint) => (layer.fill = v), t("field.color"))}

          {@render sectionTitle(t("section.outline"))}
          <label>{t("field.width")}
            {@render numSlider(layer.borderWidth, (v) => (layer.borderWidth = v), () => resetField("borderWidth", 0), 0, 0.03, 0.001)}
          </label>
          <label>{t("field.color")}<input type="color" bind:value={layer.borderColor} onchange={commit} /></label>

          {@render maskSection()}
          {@render glowSection()}
          {@render effectsSection()}
        {/if}

      </div>
    {/if}
  </div>
</div>
