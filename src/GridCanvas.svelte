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
    setTileFrame,
    tileFrame,
    swapTilePlaces,
    wall,
    toggleTile,
    visibleIds,
  } from "./lib/editor.svelte";
  import { TILE_H, TILE_W } from "./lib/bmp";
  import { cellIndexAt, cellsIn, isTyping, snapBox, type Guide } from "./lib/geometry";
  import {
    buildGrid,
    cellAt,
    freeScale,
    ghostImage,
    gridSize,
    layerSize,
    readBack,
    rebuildTile,
    snapScale,
    soleTileChange,
    standRect,
    wallPrint,
    type Tagged,
    type WallPrint,
  } from "./lib/scene";
  import { framed, layerAsset, layerText, type Layer } from "./lib/model";
  import { isLiveCopy, layerShows, offLayouts } from "./lib/stamps";

  /* On while the placing tool is chosen in App's toolbar. The wall has no other
     mode, and that is deliberate — see the note on frameAt below. */
  let { framing = false }: { framing?: boolean } = $props();

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

  /* ---- The placing tool -------------------------------------------------
   *
   * A Layout designs forty-four tiles at once, and forty-four faces are not
   * alike: the picture that wants to sit left on one sits centre on the next,
   * and a caption clear of the chin on most of them lands on it here. The
   * Layout owns the design; the tile owns where its own copy sits inside it.
   * This is the only mode the wall has, so it says so: the button stays
   * pressed, Escape leaves.
   *
   * What it acts on comes from the list on the right, not from a click on the
   * canvas. A wall is layers all the way across — clicking to choose one would
   * take the tile-selection drag with it, and picking between two that overlap
   * would be a lottery. So: choose the tile, choose the layer in its row, and
   * the frame appears on it.
   *
   * Fabric supplies the frame and its handles, but not on the layer itself — a
   * masked or flattened tile layer is baked to pixels before the cell clips it,
   * so dragging that object would take the mask along with it. What is dragged
   * is a transparent stand-in at the layer's place. A picture also gets a
   * ghost: the whole of it, faintly, including the parts the mask cuts away,
   * without which you would be nudging an invisible thing until something
   * happened to appear. */
  let target: { tileId: string; layerId: string } | null = null;
  let stand: fabric.Object | undefined;
  let ghost: fabric.Object | undefined;
  /** Whether what is being placed may be stretched — see the handles in
   *  frameAt. Kept here because the live scaling handler has only the stand-in
   *  to go on, and a stand-in is a plain rectangle whatever it stands for. */
  let twoAxes = false;

  /** The live layers drawn on a tile, newest last — the ones a tile places.
   *
   *  Live copies only. A layer the tile owns outright is already draggable on
   *  the wall and has nothing to differ from: editing it *is* editing the
   *  layer. */
  const placeableOn = (tileId: string) => {
    const own = app.manifest.tiles[tileId]?.layers ?? [];
    const off = offLayouts(own);
    return own.filter(
      (l) => isLiveCopy(l) && layerShows(l, off) && !(l.kind === "image" && !l.asset),
    );
  };

  function dropFrameTools() {
    if (stand) canvas?.remove(stand);
    if (ghost) canvas?.remove(ghost);
    stand = ghost = undefined;
    twoAxes = false;
  }

  /** The layer as the Layout asks for it on this tile — this tile's picture or
   *  class filled in, but without what the tile chose about where it sits.
   *  What a Frame is measured against. */
  function atRest(tileId: string, layerId: string): Layer | undefined {
    const layer = placeableOn(tileId).find((l) => l.id === layerId);
    if (!layer) return undefined;
    const tile = app.manifest.tiles[tileId];
    /* This tile's own wording, not the Layout's. A caption's box is measured
       from the words in it, so a frame sized off the default sat at a fifth of
       the width over a caption that fills the tile. */
    if (layer.kind === "text") return { ...layer, text: layerText(tile?.text ?? {}, layer, tileId) };
    if (layer.kind !== "image") return layer;
    const asset = layerAsset(tile?.swap ?? {}, layer);
    return asset ? { ...layer, asset } : undefined;
  }

  /** Puts the stand-in — and, for a picture, the ghost — on what this tile
   *  currently shows for that layer. */
  async function frameAt(tileId: string, layerId: string) {
    if (!canvas || !app.deps) return;
    const ids = visibleIds();
    const base = atRest(tileId, layerId);
    const index = ids.indexOf(tileId);
    /* Nothing to stand on: the tile was told to show no picture here, or it has
       left the wall. The furniture goes before the return, or the frame stays
       on the tile it was last on while the selection has moved to this one —
       and the next drag then writes onto a tile nobody is pointing at. */
    if (!base || index < 0) {
      target = null;
      dropFrameTools();
      canvas.requestRenderAll();
      return;
    }

    const shown = framed(base, tileFrame(tileId, layerId));
    const cell = cellAt(index);
    const size = layerSize(shown);
    const width = size.w * TILE_W;
    const place = {
      originX: "center" as const,
      originY: "center" as const,
      left: cell.x + shown.x * TILE_W,
      top: cell.y + shown.y * TILE_H,
      angle: shown.rotation,
    };

    /* The ghost is a picture's alone. It exists because a mask hides most of
       what is being dragged; a caption and an icon draw themselves whole, so
       the frame is enough and a second faint copy would only be in the way.
       ponytail: if a masked caption turns out to need one, extend ghostImage
       in scene.ts — the renderer's reading of a layer lives there, not here. */
    const drawn = shown.kind === "image" ? await ghostImage(shown, app.deps) : undefined;
    const height = drawn ? width * ((drawn.height || 1) / (drawn.width || 1)) : size.h * TILE_H;

    dropFrameTools();
    /* `keep` so a rebuild leaves them standing. The wall is rebuilt the moment
       a frame is written, which is the moment the mouse comes up — and the
       frame used to be swept away with everything else and fetched back
       asynchronously, so it blinked out under the hand at the end of every
       drag. buildGrid clears its own objects only. */
    if (drawn) {
      drawn.set({ ...place, opacity: 0.28, selectable: false, evented: false });
      Object.assign(drawn, { keep: true });
      drawn.scaleToWidth(width);
      ghost = drawn;
      canvas.add(drawn);
    }

    stand = standRect(place, width, height);
    /* What each kind may be resized by, offered as handles rather than only
       enforced on release — a handle you cannot honestly use is one that lies
       about what the drag will keep.
       A caption: nothing. The Layout owns the type size, and one caption bigger
       than the other forty-three reads as a mistake.
       A rectangle, ellipse or polygon: both axes, sides included. A bar drawn
       longer on one portrait is a decision.
       A picture or a class icon: corners only. Their artwork is fitted to the
       box rather than stretched into it, which is exactly what `freeScale` says
       and why it excludes icons. */
    const off = { tl: false, tr: false, bl: false, br: false, ml: false, mr: false, mt: false, mb: false };
    twoAxes = freeScale(shown);
    if (shown.kind === "text") stand.setControlsVisibility({ ...off, mtr: true });
    else if (!twoAxes)
      stand.setControlsVisibility({ ...off, tl: true, tr: true, bl: true, br: true, mtr: true });
    /* `layerId` so Fabric's own selection event writes back the layer this
       stands for instead of clearing the choice — the tool reads that same
       field to know what to place, and an empty write would take its own frame
       down. */
    Object.assign(stand, { framing: true, keep: true, layerId });
    canvas.add(stand);
    canvas.setActiveObject(stand);
    target = { tileId, layerId };
    canvas.requestRenderAll();
  }

  /** The ghost follows the stand-in while a gesture is open. */
  function syncGhost() {
    if (!stand || !ghost) return;
    ghost.set({
      left: stand.left,
      top: stand.top,
      angle: stand.angle,
      scaleX: (stand.getScaledWidth() || 1) / (ghost.width || 1),
      scaleY: (stand.getScaledWidth() || 1) / (ghost.width || 1),
    });
    ghost.setCoords();
  }

  /** What the tile chose, as a difference from what the Layout asked for. */
  async function writeFrame() {
    if (!stand || !target) return;
    const base = atRest(target.tileId, target.layerId);
    if (!base) return;
    const ids = visibleIds();
    const back = readBack(stand as Tagged, ids.length, ids.indexOf(target.tileId));
    /* The zoom measured against the layer's own resting width, whichever field
       that comes out of — one factor that means the same thing to a picture, an
       icon and a caption, which each keep their size differently.
       Not readBack's `scale`: that goes through getScaledWidth, which counts
       the frame's own 1px stroke. A plain drag then wrote a zoom of 1.003 on a
       half-tile picture and 1.011 on a caption, and every nudge multiplied it
       again — a picture that grew a little each time it was moved. */
    const rest = layerSize(base);
    const width = ((stand.width ?? 0) * (stand.scaleX ?? 1)) / TILE_W;
    const height = ((stand.height ?? 0) * (stand.scaleY ?? 1)) / TILE_H;
    await setTileFrame(target.tileId, target.layerId, {
      x: back.x - base.x,
      y: back.y - base.y,
      z: rest.w ? width / rest.w : 1,
      a: back.rotation - base.rotation,
      /* The second axis, and only where there is one to have. Written even when
         it equals the first, so a shape stretched and then squared back stores
         the square rather than an absent field the reader would fill in from
         the width. */
      ...(freeScale(base) ? { zh: rest.h ? height / rest.h : 1 } : {}),
    });
  }

  /* The frame follows the choice on the right: one tile picked, one of its live
     layers picked, and it appears on that. Leaving the mode takes the furniture
     with it, and so does a choice the wall cannot show — no tile, several
     tiles, or a layer this tile does not carry.

     Rebuilds no longer remove the pair — it is marked `keep` — so the last
     clause only puts it back when something else did, which is the case when
     the tile it stood on stops existing. */
  $effect(() => {
    if (!framing) {
      target = null;
      dropFrameTools();
      canvas?.requestRenderAll();
      return;
    }
    void app.version;
    const tile = app.selectedTiles.length === 1 ? app.selectedTiles[0] : "";
    const layerId = app.selected;
    if (!tile || !layerId || !placeableOn(tile).some((l) => l.id === layerId)) {
      if (target) {
        target = null;
        dropFrameTools();
        canvas?.requestRenderAll();
      }
      return;
    }
    if (
      target?.tileId !== tile ||
      target.layerId !== layerId ||
      !(canvas && stand && canvas.getObjects().includes(stand))
    )
      /* Reported, not dropped. This awaits a picture off disk, and both
         loadOriginal and assetUrl deliberately rethrow a failed read so a bad
         byte cannot be cached as a success — with `void` in front, the frame
         simply never appeared and the tool looked broken. The wall's own
         rebuild a few lines down has said so all along; this is the same
         failure on the same pictures. */
      frameAt(tile, layerId).catch((e) => {
        app.error = `The placing frame could not be built: ${e}`;
      });
  });

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
    const ids = visibleIds();
    const index = cellIndexAt(p.x, p.y, ids.length);
    return index < 0 ? "" : ids[index];
  }

  /* Lower than the Layout editor's 0.05 on purpose: a wall is seven tiles wide
     and as many rows deep, so "the whole thing on screen" is a far smaller
     number here than it is for one 624×804 sheet. */
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

  /* --- Redrawing one tile instead of the wall.
   *
   * A full build costs about three milliseconds a tile and runs on every edit,
   * so a wall of three hundred froze for the best part of a second every time
   * a caption moved. Almost always one tile changed and two hundred and ninety
   * nine were redrawn identically.
   *
   * Which tile that is gets answered by comparing what is drawn against what
   * should be (wallPrint/soleTileChange), rather than by asking forty mutating
   * functions to declare what they touched. A mutation nobody remembered to
   * annotate cannot go wrong, because the comparison never asked it. The rule
   * that makes the comparison sound, and the reasons the answer is a timid
   * one, are in scene.ts beside the code that applies it. --- */

  /** What is on the canvas now, or null when that is not known — before the
   *  first build, and after any build that did not finish. */
  let drawn: WallPrint | null = null;

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
          const m = $state.snapshot(app.manifest);
          const print = wallPrint(view, m);
          const one = soleTileChange(drawn, print);
          /* Forgotten before the build, not after it: a build that throws
             leaves the canvas in a state nothing here can describe, and the
             next pass has to start from a full one rather than trust a
             fingerprint for a wall that was never finished. */
          drawn = null;
          if (one) await rebuildTile(canvas, one, view, m, deps, true);
          else await buildGrid(canvas, view, m, deps, true);
          drawn = print;
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
      backgroundColor: "#17171a",
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
      /* The mode swallows nothing here. It used to take the click, to choose
         what to place; that choice comes from the list on the right now, so
         clicking the wall still picks tiles, drags still sweep a band, and
         Alt+drag still swaps — all of which you need while placing, because
         choosing the next tile is half the work.
         The stand-in is an ordinary Fabric object, so a press on it is already
         `opt.target` below and never reaches the band. */
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
          ctx.fillStyle = "rgba(166, 133, 255, 0.22)";
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = "rgba(203, 184, 255, 0.95)";
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
        ctx.fillStyle = "rgba(166, 133, 255, 0.10)";
        ctx.strokeStyle = "rgba(203, 184, 255, 0.9)";
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
    /* The frame belongs to the mode, not to the click. Fabric drops the
       selection whenever a press lands on bare canvas, which in this mode is
       most presses — so the violet box and its handles vanished under the hand
       and had to be fetched back by clicking the tile again. It stays until the
       mode is left. */
    canvas.on("selection:cleared", () => {
      if (framing && stand && canvas!.getObjects().includes(stand)) {
        canvas!.setActiveObject(stand);
        canvas!.requestRenderAll();
      }
    });

    canvas.on("selection:cleared", () => {
      /* Not while placing. There the chosen layer is what the tool acts on, and
         a press on the wall is how the next tile is chosen — clearing it there
         meant the frame died on the way to the tile it was being carried to,
         and forty-four portraits had to be picked out of the list one at a
         time. Live copies keep the id of the layer they came from, so the same
         choice lands on the next tile that carries the same Layout. */
      if (!rebuilding && !framing) selectLayer("");
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
    for (const ev of ["object:moving", "object:scaling", "object:rotating"] as const)
      canvas.on(ev, (opt) => {
        if (!stand || opt.target !== stand) return;
        /* One zoom, both axes — for everything whose artwork is fitted to its
           box rather than stretched into it. A frame stored a single number, so
           a corner pulled sideways showed a stretch that the release could not
           keep, and a preview that lies is the fault this app has already
           shipped twice.
           A rectangle, ellipse or polygon is the exception: the box *is* the
           shape, a Frame carries a second factor for it, and the stretch on
           screen is what gets written. `freeScale` draws that line already and
           is what decides which handles were offered above. */
        if (ev === "object:scaling" && !twoAxes) stand.set({ scaleY: stand.scaleX });
        syncGhost();
      });

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
      if (opt.target === stand) {
        void writeFrame();
        return;
      }
      const obj = opt.target as Tagged | undefined;
      if (!obj?.layerId) return;
      const ids = visibleIds();
      void applyTransform(obj, readBack(obj, ids.length, ids.indexOf(obj.tileId)));
    });

    const key = (e: KeyboardEvent, down: boolean) => {
      if (e.code !== "Space") return;
      // Not while typing into a field, or the space bar stops producing spaces.
      if (isTyping(document.activeElement)) return;
      /* Held, not pressed: space arms panning and the left button still does
         the dragging. The HUD used to read "space or middle-drag = pan", which
         put the two on a level and had people pressing space alone. Middle-drag
         needs no explanation and no second hand, so it is the one named; space
         keeps working for anyone who reaches for it out of habit. */
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
    <!-- English like the rest of the app, and like the Layout editor's own HUD
         three files over — the two are the same strip in two places, and one of
         them speaking German read as a half-finished build. -->
    {Math.round(zoom * 100)}% &middot; {TILE_W}&times;{TILE_H} &middot; {zoomLocked
      ? "wheel locked"
      : "wheel = zoom"} &middot; middle-drag = pan
    <!-- Written out rather than drawn as 🔒/🔓: an emoji is painted by the
         system font in its own colours, which fights the theme and changes
         shape between machines — the rule App.svelte states beside its own
         hand-drawn icons. The word says the state; the tooltip says what the
         click does. -->
    <button
      onclick={() => (zoomLocked = !zoomLocked)}
      title={zoomLocked ? "Let the wheel zoom again" : "Stop the wheel from zooming"}
    >
      Zoom {zoomLocked ? "locked" : "free"}
    </button>
    <button onclick={fit}>Fit</button>
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
    color: #d9d4e8;
    font: 12px/1.4 ui-sans-serif, system-ui, sans-serif;
  }
  .hud button {
    font: inherit;
    padding: 2px 8px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #1d1832;
    color: inherit;
    cursor: pointer;
  }
</style>
