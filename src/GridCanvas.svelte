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
    applyTransformBulk,
    assignedTiles,
    bulkTargets,
    clearAll,
    clearTiles,
    nudgeLayer,
    refreshCoverPreview,
    selectLayer,
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
    isFlattened,
    layerSize,
    readBack,
    rebuildTile,
    snapScale,
    snapWidth,
    standRect,
    tilesChanged,
    wallPrint,
    type Tagged,
    type WallPrint,
  } from "./lib/scene";
  import { findLayer, layerText, type Layer } from "./lib/model";


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

  /** How many changed tiles are still worth redrawing one at a time. A single
   *  tile costs about a third of a full wall at three hundred tiles — almost
   *  all of it paint — so a handful of targeted redraws stays ahead, and past
   *  that the full build is both cheaper and simpler. Raised from "exactly one"
   *  when an edit could first reach several tiles at once. */
  const REDRAW_MAX = 8;

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

  /** The layers on a tile the stand-in can be put on: the ones that draw. */
  const placeableOn = (tileId: string) =>
    (app.manifest.tiles[tileId]?.layers ?? []).filter(
      (l) => !l.hidden && !(l.kind === "image" && !l.asset),
    );

  function dropFrameTools() {
    if (stand) canvas?.remove(stand);
    if (ghost) canvas?.remove(ghost);
    stand = ghost = undefined;
    twoAxes = false;
    // Asked for outright: the canvas no longer repaints itself on a remove
    // (see renderOnAddRemove where it is built), and without this the frame
    // stays on screen as a ghost until something else happens to paint.
    canvas?.requestRenderAll();
  }

  /** The layer as this tile draws it — what the stand-in has to match.
   *
   *  Only a caption still needs filling in, and only because a "{{id}}"
   *  placeholder resolves against the tile: a box is measured from the words in
   *  it, and one sized off the placeholder sat at a fifth of the width over a
   *  caption that fills the tile. A picture and a class icon carry their own
   *  answers on the layer now. */
  function atRest(tileId: string, layerId: string): Layer | undefined {
    const layer = placeableOn(tileId).find((l) => l.id === layerId);
    if (!layer) return undefined;
    if (layer.kind === "text") return { ...layer, text: layerText(layer, tileId) };
    if (layer.kind !== "image") return layer;
    // "" is a real answer — no picture on this tile — and there is nothing to
    // put a frame around.
    return layer.asset ? layer : undefined;
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

    /* The layer as it stands, with nothing added on top: a Frame used to be the
       tile's private offset from a shared design, and the layer on this tile is
       the placement now. */
    const shown = base;
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
    /* `tileId` as well as the layer: applyTransform resolves the stack from the
       object's own tile, and a stand-in without one would fall back to a scan
       of the wall and write the gesture onto whichever tile matched first. */
    Object.assign(stand, { framing: true, keep: true, layerId, tileId });
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

  /** Where the gesture left the layer, written onto the layer itself.
   *
   *  It used to write a Frame: the tile's departure from where a Layout had
   *  put the layer, kept in a record of its own and added back at draw time.
   *  There is no Layout to depart from, the layer on this tile is the placement,
   *  and the record stopped being read when the stamps came apart — so the tool
   *  went on moving the stand-in over a picture that never followed. Same patch
   *  and same two functions the direct drag uses now, which is what makes the
   *  two agree. */
  async function writeFrame() {
    if (!stand || !target) return;
    const base = atRest(target.tileId, target.layerId);
    if (!base) return;
    const ids = visibleIds();
    const back = readBack(stand as Tagged, ids.length, ids.indexOf(target.tileId));
    const patch = {
      ...back,
      /* Measured off the stand-in's own box rather than taken from readBack,
         which goes through getScaledWidth and counts the frame's 1px stroke. A
         plain drag otherwise wrote 1.003 of the width on a half-tile picture
         and multiplied it again on every nudge — a picture that grew a little
         each time it was moved. */
      scale: ((stand.width ?? 0) * (stand.scaleX ?? 1)) / TILE_W,
      scaleH: ((stand.height ?? 0) * (stand.scaleY ?? 1)) / TILE_H,
      /* The stand-in is a rectangle and has no crop of its own to report, and
         resize() drops a picture's crop when the patch carries none. Handed
         back what the layer already had, so moving a trimmed picture does not
         untrim it. */
      crop: base.kind === "image" ? base.crop : undefined,
      /* The two above are the size the layer should end up at, measured off the
         frame the hand let go of — not a factor to apply to what it has. The
         stand-in keeps the scale of the gesture that just ended, so a factor
         read from it lands again on the next write and again on the one after:
         the frame grew once and the shape grew every time it was touched. */
      absolute: true,
    };
    const targets = bulkTargets(target.layerId);
    /* Structural even for a plain move, where a direct drag skips it. There the
       canvas already shows the result because the object the hand moved is the
       layer. Here the hand moved the stand-in — a transparent rectangle — and
       the layer it stands for is a different object that nothing redraws
       without a rebuild. So the frame ended up in the new place with the
       picture still in the old one, and stayed that way until anything else
       bumped the document: a lock, a hide, a field in the panel. With several
       tiles picked the bulk path bumps it regardless, which is the difference
       the report led with. */
    await (targets.length > 1
      ? applyTransformBulk(stand as Tagged, patch, targets)
      : applyTransform(stand as Tagged, patch, true));
  }

  /* The frame follows the choice on the right: one tile picked, one of its live
     layers picked, and it appears on that. Leaving the mode takes the furniture
     with it, and so does a choice the wall cannot show — no tile, several
     tiles, or a layer this tile does not carry.

     Rebuilds no longer remove the pair — it is marked `keep` — so the last
     clause only puts it back when something else did, which is the case when
     the tile it stood on stops existing. */
  $effect(() => {
    void app.version;
    const tile = app.selectedTiles.length === 1 ? app.selectedTiles[0] : "";
    const layerId = app.selected;
    /* No mode to switch on any more: the frame appears by itself, on exactly
       the layers whose own object cannot serve as a handle. A class icon and a
       masked layer are drawn as a whole-tile bake, so their handles would sit
       at the corners of the cell rather than at the edges of the layer — every
       other layer is its own handle and is dragged directly. isFlattened is the
       renderer's own rule, read from here so the two cannot drift apart. */
    const own = placeableOn(tile);
    const picked = own.find((l) => l.id === layerId);
    if (!tile || !layerId || !picked || !isFlattened(picked, own)) {
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
    // Third of the three viewport changes that have to ask for their own frame
    // — see the note on the wheel handler.
    canvas.requestRenderAll();
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

  /** A build that was owed while the hand was still on an object. Cleared by
   *  mouse:up, which asks for it again. */
  let deferred = false;

  /** Fabric's own marker for "a drag, scale or rotate is happening right now".
   *  Read rather than tracked here: the canvas is the one that knows, and a
   *  flag of ours would have to be kept in step with every way a gesture can
   *  end, including the ones that never reach mouse:up. */
  const midGesture = () =>
    !!(canvas as unknown as { _currentTransform?: unknown } | undefined)?._currentTransform;

  /* --- Redrawing one tile instead of the wall.
   *
   * A full build costs about three milliseconds a tile and runs on every edit,
   * so a wall of three hundred froze for the best part of a second every time
   * a caption moved. Almost always one tile changed and two hundred and ninety
   * nine were redrawn identically.
   *
   * Which tiles those are gets answered by comparing what is drawn against what
   * should be (wallPrint/tilesChanged), rather than by asking forty mutating
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
        /* Not under a live gesture. A rebuild takes every object off the canvas
         * and puts new ones back, and Fabric is holding a reference to the one
         * being dragged: it goes on moving an object that is no longer on the
         * canvas, and the drop is written to nothing. The layer stays where it
         * was, no undo step appears, and the wall keeps whatever it painted
         * last — which is how "I moved it and it only took effect once I
         * clicked something else" comes about, because the click was a rebuild
         * that finally drew the truth.
         *
         * A plain drag is what makes this reachable: it does not bump the
         * version, so nothing here notices the model moved under the build,
         * and there is no second pass to correct it.
         *
         * `built` is deliberately left alone, so the effect still counts this
         * version as owed; mouse:up asks again once the hand has let go. */
        if (midGesture()) {
          deferred = true;
          return;
        }
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
          const few = tilesChanged(drawn, print);
          /* Forgotten before the build, not after it: a build that throws
             leaves the canvas in a state nothing here can describe, and the
             next pass has to start from a full one rather than trust a
             fingerprint for a wall that was never finished. */
          drawn = null;
          if (few && few.length <= REDRAW_MAX) {
            // Painted once at the end rather than once per tile — see the note
            // on rebuildTile's `render`, and the numbers that forced it.
            for (const id of few) await rebuildTile(canvas, id, view, m, deps, true, false);
            canvas.renderAll();
          } else await buildGrid(canvas, view, m, deps, true);
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
  /** Is this object the selected layer *on the selected tile*?
   *
   *  The id alone is not the question. A design dissolved onto forty-four tiles
   *  puts the same layer id on all of them, so matching by id made every copy
   *  grabbable at once and handed the active handles to whichever one Fabric
   *  listed first — a caption dragged on tile 40 while the pointer was on
   *  tile 12. A wall-spanning layer has no tile and answers "" on both sides. */
  const isPick = (o: fabric.Object) =>
    (o as Tagged).layerId === app.selected && ((o as Tagged).tileId ?? "") === app.selectedTile;

  $effect(() => {
    if (!canvas) return;
    app.selected;
    app.selectedTile;
    app.version;
    void building.then(() => {
      if (!canvas) return;
      for (const o of canvas.getObjects()) {
        const mine = (o as Tagged).layerId;
        if (mine) o.evented = o.selectable = isPick(o) && !(o as Tagged).locked;
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
    app.selectedTile;
    app.version;
    if (!canvas) return;
    void building.then(() => {
      if (!canvas) return;
      const live = canvas.getActiveObject();
      if (live && isPick(live)) return;
      const obj = id && canvas.getObjects().find(isPick);
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
      /* Every add and remove asks Fabric for a repaint of its own, and a
       * repaint of this wall is nearly its whole cost — 431 of 450ms at 301
       * tiles. buildGrid and rebuildTile both paint deliberately when they are
       * done, so those requests are pure duplication; they only stay invisible
       * because Fabric defers them to the next frame and a single rebuild ends
       * before one arrives. Redraw several tiles in a row, though, and the
       * frames land between the awaits: eight tiles measured 3971ms with this
       * on against 469ms with it off. Off, and the paint stays where the code
       * puts it. */
      renderOnAddRemove: false,
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
      /* Asked for outright. Fabric hangs the repaint after a viewport change on
         renderOnAddRemove, which is off here so that building a wall does not
         ask for a frame per object — so a zoom moved the transform and
         requested nothing, and the screen caught up only when some other event
         happened to paint. Reported as "zoom only takes effect when I click
         something else". See the test in incremental.browser.test.ts, which
         pins that behaviour upstream. */
      canvas!.requestRenderAll();
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
        // Same reason as the wheel above: a pan is a viewport change, and a
        // viewport change asks for nothing while renderOnAddRemove is off.
        canvas!.requestRenderAll();
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
      /* The build the gesture was holding off. object:modified has already run
         by now and written the drop, so this pass sees the finished model. */
      if (deferred) {
        deferred = false;
        if (app.deps) void rebuild(app.deps);
      }
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
          /* Outline only. A wash over the whole cell sat on top of the artwork
             the pick was made in order to judge — colours shifted, a gradient
             read wrong, and the one tile you were looking at was the one you
             could see least well. Thick enough to count across a wall of
             forty-four at a glance. */
          ctx.strokeStyle = "rgba(203, 184, 255, 0.95)";
          ctx.lineWidth = 3;
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
      // The tile comes off the object, so a click says which portrait it meant.
      const picked = (opt.selected?.[0] ?? opt.target) as Tagged | undefined;
      selectLayer(picked?.layerId ?? "", picked?.tileId ?? "");
    };
    canvas.on("selection:created", pickedOnCanvas);
    canvas.on("selection:updated", pickedOnCanvas);
    /* Clearing during a rebuild is Fabric dropping its active object, not the
     * user letting go of the layer — letting that through would silently
     * deselect on every structural edit. */
    /* The frame belongs to the layer, not to the click. Fabric drops the
       selection whenever a press lands on bare canvas, which here is most
       presses — so the violet box and its handles vanished under the hand and
       had to be fetched back by clicking the tile again. It stays as long as
       the layer it belongs to is the chosen one. */
    canvas.on("selection:cleared", () => {
      if (stand && canvas!.getObjects().includes(stand)) {
        canvas!.setActiveObject(stand);
        canvas!.requestRenderAll();
      }
    });

    canvas.on("selection:cleared", () => {
      /* Not while a frame is up. There the chosen layer is what the frame acts
         on, and a press on the wall is how the next tile is chosen — clearing
         it meant the frame died on the way to the tile it was being carried to,
         and forty-four portraits had to be picked out of the list one at a
         time. Layers dissolved across a wall keep one id, so the same choice
         lands on the next tile carrying the same design. */
      if (!rebuilding && !stand) selectLayer("");
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

    /** What a dragged object is pulled towards.
     *
     *  A wall picture answers to the grid it spans. A tile layer answers to its
     *  own cell and to the other layers on that tile — the same pair the Layout
     *  editor offers against the sheet and its siblings, which is what makes a
     *  caption line up with the badge above it without either being measured.
     *
     *  Only its own tile's siblings: the wall is a grid of separate portraits
     *  with gaps between them in the game, so pulling a caption onto something
     *  three cells over would align it with a thing the player never sees
     *  beside it. */
    const snapTargets = (target: Tagged) => {
      if (target.space === "grid") {
        const grid = gridSize(visibleIds().length);
        return [{ left: 0, top: 0, width: grid.w, height: grid.h }];
      }
      const at = cellAt(visibleIds().indexOf(target.tileId));
      const cell = { left: at.x, top: at.y, width: TILE_W, height: TILE_H };
      const siblings = canvas!
        .getObjects()
        .filter(
          (o) =>
            o !== target &&
            (o as Tagged).tileId === target.tileId &&
            (o as Tagged).space === "tile" &&
            !(o as { keep?: boolean }).keep,
        )
        .map((o) => o.getBoundingRect());
      return [cell, ...siblings];
    };

    canvas.on("object:moving", (opt) => {
      guides = [];
      const target = opt.target as Tagged | undefined;
      if (!target?.layerId || (opt.e as MouseEvent | undefined)?.altKey) return;

      /* Fabric has written the new left/top but not refreshed the cached corner
       * coordinates getBoundingRect reads — without this the box is one
       * drag-step stale and the correction lands short. */
      target.setCoords();
      // Threshold in screen pixels, converted here, so the pull feels the same
      // however far the view is zoomed out — and the wall is usually far out.
      const snap = snapBox(
        target.getBoundingRect(),
        snapTargets(target),
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
      if (!target?.layerId || !corner) return;
      if ((opt.e as MouseEvent | undefined)?.altKey) return;
      /* Uniform for a wall picture, which carries one scale; a tile layer
       * follows its own kind's rule — the same `freeScale` that decided which
       * handles it was given in the first place. */
      const layer = findLayer(app.manifest.tiles[target.tileId]?.layers ?? [], target.layerId);
      guides = snapScale(
        target,
        corner,
        snapTargets(target),
        SNAP_PX / canvas!.getZoom(),
        target.space === "grid" || !layer || !freeScale(layer),
      );
    });

    /* A caption's side handles resize its box instead of scaling it, which
     * Fabric reports as its own event — so without this the one gesture that
     * decides where a line wraps was the one gesture with no pull at all. */
    canvas.on("object:resizing", (opt) => {
      guides = [];
      const target = opt.target as Tagged | undefined;
      const corner = opt.transform?.corner;
      if (!target?.layerId || !corner) return;
      if ((opt.e as MouseEvent | undefined)?.altKey) return;
      guides = snapWidth(target, corner, snapTargets(target), SNAP_PX / canvas!.getZoom());
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
      /* A baked layer sits at its cell's origin at scale 1 whatever the model
       * says, so reading its transform back would write 0,0 over a real
       * placement — measuring the bake instead of the layer.
       *
       * It used to be refused outright here, which left the gesture half done:
       * Fabric moves the object during the drag whatever this handler decides,
       * so a refused drop left a class icon lying where it was dropped, with
       * the model still holding the old position, until some later action
       * rebuilt the tile and it jumped back. Reported as "the tile only
       * updates once I do something else" — and on this document that is most
       * of the wall, since a class icon is baked and 39 of 67 layers are one.
       *
       * The distance is readable even though the position is not: the bake
       * starts at the cell's origin, so what it has moved away from that is
       * exactly what the hand dragged. Written as a nudge, which is also why
       * these keep no scale handles — the bake is tile-sized, and a factor
       * read off it would mean nothing. */
      if (obj.flattened) {
        const at = cellAt(ids.indexOf(obj.tileId));
        void nudgeLayer(obj, ((obj.left ?? 0) - at.x) / TILE_W, ((obj.top ?? 0) - at.y) / TILE_H);
        return;
      }
      const patch = readBack(obj, ids.length, ids.indexOf(obj.tileId));
      /* With several tiles picked, one drag places the layer on all of them —
       * the wall's answer to what a Layout did by owning the design. A layer
       * spanning the whole wall has no tile and no siblings to match. */
      const targets = obj.tileId ? bulkTargets(obj.layerId) : [];
      void (targets.length > 1
        ? applyTransformBulk(obj, patch, targets)
        : applyTransform(obj, patch));
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
