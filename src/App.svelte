<script lang="ts">
  /* Bare shell, still. Two documents live here — the wall and one open Layout —
   * and which is showing decides both the canvas in the middle and what the
   * side panel lists. The tool strip and dense token set land in M4; this
   * exists to drive the layout/stamp path end to end. */
  import { onMount, tick } from "svelte";
  import { ask } from "./lib/platform";

  import ContextMenu, { type Item } from "./ContextMenu.svelte";
  import GridCanvas from "./GridCanvas.svelte";
  import LayoutCanvas from "./LayoutCanvas.svelte";
  import Properties from "./Properties.svelte";
  import {
    addGridImage,
    addLayoutImage,
    addLayoutShape,
    addLayoutText,
    app,
    assignTileLayout,
    bakedCount,
    bakeMosaic,
    canAddGridImage,
    canBakeMosaic,
    canGroupLayers,
    canSaveToGame,
    canSaveLayout,
    clearMosaic,
    coverCounts,
    coverTheWall,
    clearTileAsset,
    clearTileText,
    clearTiles,
    closeLayoutDoc,
    deleteLayer,
    deleteLayoutDoc,
    deleteLayoutLayer,
    deleteProject,
    dropLayoutLayer,
    dropTileLayer,
    duplicateLayoutDoc,
    endGesture,
    fileTile,
    folders,
    freeCount,
    groupLayoutLayers,
    inbox,
    keepCharacter,
    layoutGroups,
    looseIds,
    layoutTiles,
    layoutUsage,
    layouts,
    moveLayersIntoGroup,
    moveTilesToProject,
    newFolderHere,
    newLayoutDoc,
    newProjectFrom,
    openFolder,
    openLayout,
    openLayoutDoc,
    openProject,
    openProjectView,
    placeTileAt,
    projects,
    redoEdit,
    redoable,
    releaseTilesToInbox,
    replaceCharacter,
    renameLayer,
    renameLayout,
    renameFolder,
    renameProject,
    restorableCount,
    restoreProject,
    removeFolder,
    saveLayout,
    saveToGame,
    selectLayer,
    selectLayoutLayer,
    setTileText,
    pickTileImage,
    setTileAsset,
    tileAsset,
    tileCaptions,
    tileImageChoices,
    tileImages,
    tileLayers,
    shelfIds,
    tileProject,
    unplace,
    tileText,
    visibleIds,
    toggleLayerHidden,
    toggleLayerLocked,
    toggleLayoutLayerHidden,
    toggleLayoutPick,
    toggleTile,
    undoEdit,
    undoable,
  } from "./lib/editor.svelte";
  import { isTyping } from "./lib/geometry";
  import { findLayer, isLiveCopy, layerLabel, layoutNeedsRestamp, type Layer } from "./lib/model";

  const editing = $derived(openLayout());

  /* The FaceTexture folder is the only one this tool ever edits, so asking
     which one on every start was a dialog with one right answer. */
  onMount(() => void openFolder());

  function shortcut(e: KeyboardEvent) {
    if (isTyping(e.target)) return;
    const key = e.key.toLowerCase();

    if (key === "escape" && editing && !e.ctrlKey) {
      closeLayoutDoc();
      e.preventDefault();
      return;
    }
    if (!e.ctrlKey) return;
    // Ctrl+Shift+Z as well as Ctrl+Y — both are in wide use and cost one clause.
    if (key === "z" && !e.shiftKey) void undoEdit();
    else if (key === "y" || (key === "z" && e.shiftKey)) void redoEdit();
    else return;
    e.preventDefault();
  }

  /** Which group rows are expanded. View state only — collapsing a group is
   *  not an edit and has no business in the manifest or in undo. */
  /* Projects starts open: it is the way into a wall, and a first run that
     shows a collapsed heading and nothing else looks like an app that failed
     to load its folder. Everything else earns its twisty by being long. */
  let open = $state(new Set<string>(["projects"]));
  const toggleOpen = (id: string) => {
    open.has(id) ? open.delete(id) : open.add(id);
    open = new Set(open);
  };

  /* Follow the pick into the list. One tile: open its row, so the wording and
     the picture it carries are right there — with forty-four rows the tile you
     just clicked on the wall is usually somewhere off-screen. Several: leave
     the rows shut, because twenty open editors is not a list any more, and
     only scroll to the topmost of them.

     Nothing happens while the section is collapsed: it was collapsed on
     purpose, and there is no row to scroll to anyway. */
  $effect(() => {
    const picked = app.selectedTiles;
    if (!picked.length || !open.has("tiles")) return;
    if (picked.length === 1 && !open.has(picked[0])) toggleTileRow(picked[0]);
    const first = visibleIds().find((id) => picked.includes(id)) ?? picked[0];
    // After the row exists, not before — opening it is what creates it.
    void tick().then(() =>
      document.querySelector(`[data-tile="${first}"]`)?.scrollIntoView({ block: "nearest" }),
    );
  });

  /** Opens one tile row and shuts whichever was open before.
   *
   *  An accordion only for tile rows — drawers and the section heads share the
   *  same set and stay independent of each other. A row carries the wording
   *  fields and the picture gallery now, so two of them open at once is a list
   *  you have to scroll past to reach the next id. */
  function toggleTileRow(id: string) {
    const wasOpen = open.has(id);
    for (const tile of visibleIds()) open.delete(tile);
    if (!wasOpen) open.add(id);
    open = new Set(open);
  }

  /** The sidebar's scroller, and whether it has travelled far enough that
   *  getting back to the top is worth a button rather than a flick. */
  let pane: HTMLElement | undefined = $state();
  let scrolled = $state(false);

  /** The row being renamed, "" for none. One at a time by construction. */
  let renaming = $state("");

  /** The wall canvas, for the one thing App needs from it: which tile is under
   *  a right-click. */
  let grid: GridCanvas | undefined = $state();

  /** An object URL for a stored asset, for the gallery thumbnails. Goes through
   *  the same loader the canvas uses, which caches per asset — so showing the
   *  same logo on twenty tiles costs one decode. */
  const assetUrl = (asset: string) => app.deps?.asset(asset) ?? Promise.resolve("");

  /** Paints a tile's untouched portrait into a small canvas.
   *
   *  Through `deps.original`, which is the same cached loader the wall uses, so
   *  a thumbnail costs no decode of its own. A canvas rather than an image
   *  element, because that loader hands back an ImageBitmap and there is no URL
   *  for one — and adding a second IO path for pictures the app already holds
   *  in memory would be a cache to keep in step for no gain. */
  function portrait(el: HTMLCanvasElement, id: string) {
    let live = true;
    void (async () => {
      const bmp = await app.deps?.original(id);
      if (!live || !bmp) return;
      const ctx = el.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.drawImage(bmp, 0, 0, el.width, el.height);
    })();
    return { destroy: () => (live = false) };
  }

  /** The never-seen-before ids that are still sitting in the inbox. Ones
   *  already sorted into a project are no longer news. */
  const freshHere = () => app.newTiles.filter((id) => !tileProject(id));

  /** Which wall the stage is showing, or the overview when none. */
  let home = $state(true);
  const enter = (id: string) => {
    openProjectView(id);
    home = false;
  };
  /* Back to the overview whenever a different folder is loaded: the walls it
     offers are the ones in that folder, and a project id from the last one
     names nothing here. */
  $effect(() => {
    app.dir;
    home = true;
  });

  /** The Layout canvas — the toolbar's align buttons act on its live objects. */
  let sheet: LayoutCanvas | undefined = $state();
  const noPick = $derived(!editing || !app.layoutSelection.length);
  const fewPicked = $derived(!editing || app.layoutSelection.length < 3);

  /* --- Dragging rows to reorder. Native HTML drag-and-drop rather than
     pointer bookkeeping: it is what the browser already knows how to do, and
     Tauri's own OS-level file drop is switched off (tauri.conf.json) precisely
     so this keeps working.

     A row is a source, and it is a target in three places: the top third
     drops in front of it, the bottom third behind it, and — on a group — the
     middle third drops inside. That is the whole vocabulary; anything more
     needs a mode. --- */

  type Where = "before" | "after" | "into";
  let dragId = $state("");
  let dropOn = $state<{ id: string; where: Where } | null>(null);

  /** The shelved tile being carried onto the wall, "" for none. Separate from
   *  `dragId`, which carries layer rows: the two land in different places and
   *  sharing one field would let a layer drop reorder the grid. */
  let dragTile = $state("");

  /** Which third of the row the pointer is in. "into" only where it means
   *  something, so a plain row never offers a target that cannot take it. */
  function zone(e: DragEvent, canHold: boolean): Where {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const t = (e.clientY - box.top) / box.height;
    if (canHold && t > 0.3 && t < 0.7) return "into";
    return t < 0.5 ? "before" : "after";
  }

  const startDrag = (e: DragEvent, id: string) => {
    dragId = id;
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  };

  function over(e: DragEvent, id: string, canHold: boolean) {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    const where = zone(e, canHold);
    if (dropOn?.id !== id || dropOn.where !== where) dropOn = { id, where };
  }

  const endDrag = () => {
    dragId = "";
    dropOn = null;
  };

  /** Where a drop lands, expressed as the model wants it: the row to go in
   *  front of, and the group to go inside. `after` becomes "in front of the
   *  next sibling", or the end of the list. */
  function landing(rows: Layer[], id: string, where: Where, parentId: string | null) {
    if (where === "into") return { parentId: id, beforeId: null };
    /* `rows` is drawn topmost-first; the model stores bottom-first, so the two
     * run in opposite directions. Dropping *above* a row means landing after
     * it in the model — which is "in front of" whatever the row above it is,
     * or the end of the list when there is nothing above. Dropping *below* it
     * means landing in front of that row itself. */
    const at = rows.findIndex((l) => l.id === id);
    // The list the anchor lives in is where the layer lands, so a drop between
    // two children stays inside their group instead of escaping to the top.
    return { parentId, beforeId: where === "before" ? (rows[at - 1]?.id ?? null) : id };
  }

  /* Enter and Escape both blur; Escape puts the old text back first, and the
     rename actions already ignore an unchanged name — so cancelling needs no
     flag of its own. */
  function renameKey(e: KeyboardEvent, was: string) {
    const input = e.currentTarget as HTMLInputElement;
    if (e.key === "Escape") input.value = was;
    else if (e.key !== "Enter") return;
    input.blur();
    e.stopPropagation();
  }

  /** A yes/no the user actually answered.
   *
   *  A dialog that cannot open must not read as "no". It did: the confirmation
   *  was awaited inside a condition, so a rejected ask aborted the action with
   *  no dialog, no error and no change — a button that did nothing. Cancelling
   *  is still the safe answer when it fails, but now it says so. */
  async function confirmed(message: string, title: string) {
    try {
      return await ask(message, { title, kind: "warning" });
    } catch (e) {
      app.error = `Could not ask for confirmation: ${e}`;
      return false;
    }
  }

  /** Deleting a Layout leaves its stamps behind as pictures nothing owns —
   *  they keep rendering, but the row falls back to the asset hash and there
   *  is no way back except undo. Worth the same warning a group gets. */
  async function removeLayout(id: string, name: string) {
    const used = layoutUsage(id);
    if (
      used &&
      !(await confirmed(
        // Both units again: the pictures left behind are counted per stamp,
        // but what the deletion is visible on is tiles.
        `"${name}" is stamped ${used} time(s), on ${layoutTiles(id)} tile(s). ` +
          `The stamps stay behind as nameless pictures.`,
        "Delete layout?",
      ))
    )
      return;
    await deleteLayoutDoc(id);
  }

  /** Puts the game's own portraits back over this project's tiles.
   *
   *  Asks first even though nothing in the document changes: it is the one
   *  action here that reaches into the game folder without being reversible by
   *  Ctrl+Z, and the way back is a second deliberate press of Write to game. */
  async function resetProject() {
    const p = openProject();
    if (!p) return;
    if (
      !(await confirmed(
        `Put the game's original portraits back for ${restorableCount()} tile(s) of "${p.name}"? ` +
          `Your layers and arrangement stay — press Write to game to put them back on.`,
        "Reset in game?",
      ))
    )
      return;
    await restoreProject();
  }

  /** Deleting a project hands its tiles back to the inbox with every layer
   *  still on them — artwork belongs to the portrait, not to the wall it was
   *  arranged on. What is actually lost is the arrangement, which is the one
   *  thing worth asking about. */
  async function removeProject(id: string, name: string) {
    const p = projects().find((x) => x.id === id);
    const placed = p?.order.length ?? 0;
    if (
      placed &&
      !(await confirmed(
        `"${name}" holds ${placed} tile(s). They go back to Unsorted and keep their layouts; ` +
          `the arrangement is what you lose.`,
        "Delete project?",
      ))
    )
      return;
    await deleteProject(id);
  }

  /** A holder's rows as the list draws them: topmost first, and without the
   *  live copies a Layout keeps there — the stamp row speaks for them. */
  const stampsOf = (layers: Layer[]) => [...layers].reverse().filter((l) => !isLiveCopy(l));

  /** A stamp shows its Layout's name; anything else falls back to layerLabel. */
  const stampName = (l: Layer) =>
    (l.kind === "image" && l.layoutId && layouts().find((x) => x.id === l.layoutId)?.name) ||
    layerLabel(l);

  const stampDirty = (l: Layer) => {
    if (l.kind !== "image" || !l.layoutId) return false;
    const layout = layouts().find((x) => x.id === l.layoutId);
    return !!layout && layoutNeedsRestamp(layout);
  };

  /** The picture spread across the open project's wall, if one is placed. It
   *  belongs to the wall rather than to any tile, so it gets its own section. */
  const wallLayers = $derived([...(openProject()?.gridLayers ?? [])].reverse());

  const layoutLayers = $derived(editing ? [...editing.layers].reverse() : []);

  /** The one layer the properties panel edits. Shown for a single pick only:
   *  with several selected the fields would have to merge differing values,
   *  which is a whole design of its own and nothing needs it yet. */
  const selectedLayoutLayer = $derived(
    editing && app.layoutSelection.length === 1
      ? findLayer(editing.layers, app.layoutSelection[0])
      : undefined,
  );

  /* One context menu serves both documents: the wall right-clicks tiles, the
     Layout editor right-clicks layers, and only the item list differs. */
  let menu: { x: number; y: number; items: Item[] } | null = $state(null);

  function wallMenu(e: MouseEvent) {
    if (editing) return;
    /* Right-clicking bare wall with nothing picked used to do nothing at all,
       while the layer list picks the row under the cursor first. GridCanvas
       answers which tile is there, since only it knows the viewport. */
    if (!app.selectedTiles.length) {
      const under = grid?.tileAtEvent(e);
      if (!under) return;
      app.selectedTiles = [under];
    }
    e.preventDefault();
    const picked = app.selectedTiles.length;
    const elsewhere = projects().filter((p) => p.id !== app.openProjectId);
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: picked > 1 ? `New project from ${freeCount()} tiles` : "New project from selection",
          run: () => void newProjectFrom(""),
          disabled: !freeCount(),
        },
        ...(elsewhere.length ? [{ separator: true } as Item] : []),
        // Moving carries the tile's layers with it: artwork belongs to the
        // portrait, not to the wall it happens to be arranged on.
        ...elsewhere.map((p) => ({
          label: `Move to "${p.name}"`,
          run: () => void moveTilesToProject(p.id),
        })),
        ...(app.openProjectId
          ? [
              { separator: true } as Item,
              {
                label: picked === 1 ? "Back to Unsorted" : `Send ${picked} back to Unsorted`,
                run: () => void releaseTilesToInbox(),
              },
            ]
          : []),
      ],
    };
  }

  /** Right-click in the Layout's layer list. Picks the row first when it is
   *  not already part of the selection, the way every list does. */
  function layerMenu(e: MouseEvent, layerId: string) {
    e.preventDefault();
    if (!app.layoutSelection.includes(layerId)) selectLayoutLayer(layerId);
    const picked = [...app.layoutSelection];
    const targets = layoutGroups().filter((g) => !picked.includes(g.id));
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: picked.length > 1 ? `Group ${picked.length} layers` : "Group",
          run: () => void groupLayoutLayers(),
          disabled: !canGroupLayers(),
        },
        ...(targets.length ? [{ separator: true } as Item] : []),
        ...targets.map((g) => ({
          label: `Move into "${layerLabel(g)}"`,
          run: () => void moveLayersIntoGroup(g.id, picked),
        })),
        { separator: true },
        { label: "Rename", run: () => (renaming = layerId) },
        {
          label: findLayer(editing?.layers ?? [], layerId)?.kind === "group" ? "Ungroup" : "Delete",
          run: () => void deleteLayoutLayer(layerId),
        },
      ],
    };
  }
</script>

<!-- `change` is the browser's own "this control is finished" signal — it fires
     when a slider is released, a colour is chosen, a field is left or Enter is
     pressed — and it bubbles all the way up here. One listener therefore closes
     the undo run for every form control in the app, which is what lets history
     coalesce edits without a clock: a slider dragged in one go stays one step,
     and picking the same slider up again is a second one. Canvas gestures have
     no `change` event and call endGesture themselves. -->
<svelte:window onkeydown={shortcut} onchange={endGesture} />

<!-- A few portraits off a wall, so a card is recognisable without being
     opened. Four is enough to tell two accounts apart and cheap enough that the
     overview costs nothing; the rest is a count. -->
{#snippet thumbs(ids: string[])}
  <span class="strip">
    {#each ids.slice(0, 4) as id (id)}
      <canvas class="thumb" width="39" height="50" use:portrait={id}></canvas>
    {/each}
    {#if ids.length > 4}<span class="more">+{ids.length - 4}</span>{/if}
  </span>
{/snippet}

<!-- One Layout row per layer, recursing into groups. A snippet rather than a
     component because it needs nothing but the list it draws, and a component
     would mean threading every action through props. -->
{#snippet layerRows(rows: Layer[], nested: boolean, parentId: string | null)}
  <ul class:indent={nested}>
    {#each rows as layer (layer.id)}
      <li
        class:selected={app.layoutSelection.includes(layer.id)}
        class:drop-before={dropOn?.id === layer.id && dropOn.where === "before"}
        class:drop-after={dropOn?.id === layer.id && dropOn.where === "after"}
        class:drop-into={dropOn?.id === layer.id && dropOn.where === "into"}
        draggable="true"
        ondragstart={(e) => startDrag(e, layer.id)}
        ondragover={(e) => over(e, layer.id, layer.kind === "group")}
        ondragleave={() => dropOn?.id === layer.id && (dropOn = null)}
        ondragend={endDrag}
        ondrop={(e) => {
          e.preventDefault();
          const spot = dropOn;
          const moving = dragId;
          endDrag();
          if (!spot || !moving) return;
          const spotIn = landing(rows, spot.id, spot.where, parentId);
          void dropLayoutLayer(moving, spotIn.parentId, spotIn.beforeId);
        }}
        oncontextmenu={(e) => layerMenu(e, layer.id)}
      >
        <button
          class="eye"
          title={layer.hidden ? "Show" : "Hide"}
          onclick={() => toggleLayoutLayerHidden(layer.id)}
        >
          {@render eyeIcon(!!layer.hidden)}
        </button>
        <button
          class="eye"
          title={layer.locked ? "Unlock" : "Lock"}
          onclick={() => toggleLayerLocked(layer.id)}
        >
          {@render lockIcon(!!layer.locked)}
        </button>
        {#if renaming === layer.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="rename"
            autofocus
            value={layerLabel(layer)}
            onblur={(e) => {
              void renameLayer(layer.id, e.currentTarget.value);
              renaming = "";
            }}
            onkeydown={(e) => renameKey(e, layerLabel(layer))}
          />
        {:else}
          <button
            class="name"
            class:dimmed={layer.hidden}
            class:group-name={layer.kind === "group"}
            onclick={(e) => toggleLayoutPick(layer.id, e.ctrlKey || e.shiftKey)}
            ondblclick={() => (renaming = layer.id)}
            title="Ctrl-click picks several, double-click renames"
          >
            {layer.kind === "group" ? "▾ " : ""}{layerLabel(layer)}
          </button>
        {/if}
        <button
          title={layer.kind === "group" ? "Ungroup, the layers stay" : "Delete"}
          onclick={() => deleteLayoutLayer(layer.id)}>×</button
        >
      </li>
      {#if layer.kind === "group"}
        {@render layerRows([...layer.children].reverse(), true, layer.id)}
      {/if}
    {/each}
  </ul>
{/snippet}

<!-- Monochrome and drawn here, not typed as emoji. An emoji is rendered by the
     system font in its own colours, which fights every theme it lands in and
     changes shape between machines. These take currentColor and stay put. -->
{#snippet eyeIcon(hidden: boolean)}
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M1 7c1.8-2.7 3.8-4 6-4s4.2 1.3 6 4c-1.8 2.7-3.8 4-6 4s-4.2-1.3-6-4z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
    />
    {#if hidden}
      <line x1="2.5" y1="11.5" x2="11.5" y2="2.5" stroke="currentColor" stroke-width="1.2" />
    {:else}
      <circle cx="7" cy="7" r="1.9" fill="currentColor" />
    {/if}
  </svg>
{/snippet}

{#snippet lockIcon(locked: boolean)}
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <rect
      x="3"
      y="6.2"
      width="8"
      height="6"
      rx="1"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
    />
    <!-- The shackle swings open to the right when it is unlocked, which is the
         whole difference a glance has to catch. -->
    <path
      d={locked ? "M5 6.2V4.6a2 2 0 0 1 4 0v1.6" : "M5 6.2V4.6a2 2 0 0 1 4 0"}
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
    />
  </svg>
{/snippet}

<!-- The stamps on one holder — a group's stack or a single tile's own. Same
     row either way, so `drop` is the only thing that differs: which list the
     reorder writes back to. -->
{#snippet stampRows(rows: Layer[], drop: (moving: string, beforeId: string | null) => void)}
  <ul class="indent">
    {#each rows as layer (layer.id)}
      <li
        class:selected={app.selected === layer.id}
        class:drop-before={dropOn?.id === layer.id && dropOn.where === "before"}
        class:drop-after={dropOn?.id === layer.id && dropOn.where === "after"}
        draggable="true"
        ondragstart={(e) => startDrag(e, layer.id)}
        ondragover={(e) => over(e, layer.id, false)}
        ondragleave={() => dropOn?.id === layer.id && (dropOn = null)}
        ondragend={endDrag}
        ondrop={(e) => {
          e.preventDefault();
          const spot = dropOn;
          const moving = dragId;
          endDrag();
          if (!spot || !moving) return;
          drop(moving, landing(rows, spot.id, spot.where, null).beforeId);
        }}
      >
        <button
          class="eye"
          title={layer.hidden ? "Show" : "Hide"}
          onclick={() => toggleLayerHidden(layer.id)}
        >
          {@render eyeIcon(!!layer.hidden)}
        </button>
        <button
          class="name"
          class:dimmed={layer.hidden}
          onclick={() => selectLayer(layer.id)}
          ondblclick={() => layer.layoutId && openLayoutDoc(layer.layoutId)}
          title="Double-click opens the layout"
        >
<!-- Marker before the name, not after: the name is what gets
               ellipsised when the row runs out of width, and a dot hidden
               behind "…" is the same as no dot at all. -->{#if stampDirty(layer)}<span
              class="dirty"
              title="Layout changed — press Update stamps">●&nbsp;</span
            >{/if}{stampName(layer)}
        </button>
        <button title="Delete" onclick={() => deleteLayer(layer.id)}>×</button>
      </li>
    {/each}
  </ul>
{/snippet}

<main>
  <header>
    <div class="docs" role="group" aria-label="Document">
      <button
        class:active={!editing && home}
        onclick={() => {
          closeLayoutDoc();
          home = true;
        }}
        disabled={!app.dir}>Home</button
      >
      {#if !home}
        <button class:active={!editing} onclick={closeLayoutDoc} disabled={!app.dir}>
          {openProject()?.name ?? "Unsorted"}
        </button>
      {/if}
      {#if editing}
        <button class="active" title="Esc closes">{editing.name}</button>
      {/if}
    </div>

    {#if editing}
      <button
        onclick={() => saveLayout(editing.id)}
        disabled={!canSaveLayout(editing.id) || !!app.busy}
        title={layoutUsage(editing.id)
          ? `Applies the changes to ${layoutUsage(editing.id)} stamp(s)`
          : "Not stamped anywhere yet"}
      >
        <!-- Not "Save": the Layout is written to disk on every edit, so a
             save button would promise something that already happened. What
             this does is re-render and swap the picture in every stamp. -->
        Update stamps{#if layoutUsage(editing.id)}&nbsp;({layoutUsage(editing.id)}){/if}
      </button>
    {:else}
      <!-- Every button below acts on the wall in front of you, and on the
           overview there is none. The open project is deliberately remembered
           while Home shows — that is what makes the way back one click — so
           these cannot ask openProject() whether there is a wall; only `home`
           knows. -->
      <button onclick={() => newProjectFrom("")} disabled={!freeCount() || !!app.busy || home}>
        Project from selection
        {#if freeCount()}({freeCount()}){/if}
      </button>
      <button
        onclick={addGridImage}
        disabled={!canAddGridImage() || !!app.busy || home}
        title={canAddGridImage()
          ? "A picture spread across this wall"
          : "Open a project first — a wall picture belongs to a wall"}
      >
        Image across the grid
      </button>
      <!-- The count is the point. Baking skips any tile the picture does not
           cover completely — a tile's base is a full-bleed crop, so half of one
           cannot be stored — and that rule used to be invisible until the wall
           came back with a row missing. A new picture starts "as wide as the
           grid", which on a seven-row wall reaches only the middle rows. -->
      <!-- One press for the guarantee. The picture keeps its proportions, so
           whichever axis falls short decides the size and the other overhangs
           — there is no arrangement that lays all four edges on the wall's
           unless the shapes happen to match. Dragging afterwards snaps to
           those edges, with Alt to override. -->
      <button
        onclick={coverTheWall}
        disabled={!canBakeMosaic() || !!app.busy || home}
        title="Sizes and centres the picture so every tile lies under it"
      >
        Cover the wall
      </button>
      <button
        onclick={bakeMosaic}
        disabled={!canBakeMosaic() || !!app.busy || home}
        title={canBakeMosaic()
          ? `${coverCounts().covered} of ${coverCounts().total} tiles lie fully under the picture; the outlined ones are what Apply bakes`
          : "Select a wall picture first"}
      >
        Apply{#if canBakeMosaic()}&nbsp;({coverCounts().covered}/{coverCounts().total}){/if}
      </button>
      <!-- The way back out of that bake. A baked background hides the portrait
           completely — background() never reads the file while one is set — so
           without this a mosaic applied in some earlier session leaves a wall
           that looks like the app cannot load its own folder. The count is in
           the label because the button takes the whole wall at once; one
           Ctrl+Z puts it back. -->
      <button
        onclick={clearMosaic}
        disabled={!bakedCount() || !!app.busy || home}
        title="Removes the baked mosaic from every tile, so the portraits show again"
      >
        Restore portraits{#if bakedCount()}&nbsp;({bakedCount()}){/if}
      </button>
      <button
        onclick={saveToGame}
        disabled={!canSaveToGame() || !!app.busy || home}
        title={canSaveToGame()
          ? "Writes this project's placed tiles into the game folder"
          : "Open a project with tiles on its grid — Unsorted is not a wall"}
      >
        Write to game
      </button>
      <!-- The way back into the game, not out of the work: this writes the
           vaulted originals over the game's files and touches neither a layer
           nor an arrangement, so Write to game puts everything straight back.
           Not undoable, because nothing in the document changed — which is
           exactly why it asks first. -->
      <button
        onclick={resetProject}
        disabled={!restorableCount() || !!app.busy || home}
        title={restorableCount()
          ? "Puts the game's own portraits back for this project; your layers stay"
          : "Open a project first"}
      >
        Reset in game
      </button>
    {/if}

    <span class="status">
      {#if app.busy}
        {app.busy}…
      {:else if app.error}
        {app.error}
      {:else if editing && canSaveLayout(editing.id)}
        Saved &middot; changes not on the tiles yet
      {:else if editing}
        Saved
      {:else if app.selectedTiles.length}
        {app.selectedTiles.length} selected{#if freeCount() < app.selectedTiles.length}, {freeCount()}
          of them unassigned{/if}
        <button class="link" onclick={clearTiles}>clear</button>
      {:else if app.dir}
        {openProject()?.name ?? "Unsorted"} &middot; {visibleIds().length} tiles &middot; drag selects,
        Ctrl adds, Alt+drag swaps
      {/if}
    </span>
  </header>

  <div class="body">
    <!-- One fixed toolbar for both views, two columns: the left column holds
         the horizontal half of a pair, the right the vertical. Fixed rather
         than appearing with the mode: a control with a permanent home can be
         found before it is needed, and greying out says "open a Layout first"
         better than absence does. -->
    <div class="tools" role="toolbar" aria-label="Tools">
      {#snippet tool(label: string, glyph: string, run: () => void, off: boolean)}
        <button title={label} disabled={off || !!app.busy} onclick={run}>{glyph}</button>
      {/snippet}
      {@render tool("Undo (Ctrl+Z)", "↶", () => void undoEdit(), !undoable())}
      {@render tool("Redo (Ctrl+Y)", "↷", () => void redoEdit(), !redoable())}
      <span class="gap"></span>
      <!-- Framed mountain and sun, the icon every editor uses for a picture —
           no Unicode glyph reads as one at this size. -->
      <button title="Insert image" disabled={!editing || !!app.busy} onclick={() => void addLayoutImage()}>
        <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
          <rect x="1" y="1" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <circle cx="5.4" cy="5" r="1.4" fill="currentColor" />
          <path d="M3 11.4 L7 7 L9.5 9.6 L11.5 7.6 L13.6 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
      </button>
      {@render tool("Insert text", "T", () => void addLayoutText(), !editing)}
      {@render tool("Rectangle", "▭", () => void addLayoutShape("rect"), !editing)}
      {@render tool("Ellipse", "◯", () => void addLayoutShape("ellipse"), !editing)}
      {@render tool("Polygon", "⬡", () => void addLayoutShape("polygon"), !editing)}
      <span></span>
      <span class="gap"></span>
      {@render tool("Align left", "⇤", () => sheet?.alignTo("left"), noPick)}
      {@render tool("Align right", "⇥", () => sheet?.alignTo("right"), noPick)}
      {@render tool("Center horizontally", "↔", () => sheet?.alignTo("centerX"), noPick)}
      {@render tool("Center vertically", "↕", () => sheet?.alignTo("centerY"), noPick)}
      {@render tool("Align top", "⤒", () => sheet?.alignTo("top"), noPick)}
      {@render tool("Align bottom", "⤓", () => sheet?.alignTo("bottom"), noPick)}
      {@render tool("Equal horizontal gaps", "⇹", () => sheet?.spreadBy("x"), fewPicked)}
      {@render tool("Equal vertical gaps", "⇳", () => sheet?.spreadBy("y"), fewPicked)}
    </div>

    <!-- Capture phase: Fabric stops contextmenu on its own canvas, so a
         bubbling listener out here never sees a right-click on the wall.
         Capture runs on the way down, before the target's own handlers. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- The wall is the drop target for a shelved tile. GridCanvas already
         knows how to turn a screen point into a cell (tileAtEvent), so the drop
         only has to ask it which portrait it landed on and place the carried
         tile in front of that one — or at the end, past the last. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="stage"
      class:dropping={!!dragTile}
      oncontextmenucapture={wallMenu}
      ondragover={(e) => dragTile && e.preventDefault()}
      ondrop={(e) => {
        e.preventDefault();
        const moving = dragTile;
        dragTile = "";
        if (moving) void placeTileAt(moving, grid?.tileAtEvent(e) || null);
      }}
    >
      {#if editing}
        <LayoutCanvas bind:this={sheet} />
      {:else if home}
        <!-- The start view, always. With several accounts sharing one folder
             there is no single "the" wall to open, and a newly created
             character has to be visible the moment it turns up — so the way in
             is a choice of wall rather than a guess at one. -->
        <div class="home">
          {#if app.changedTiles.length}
            <!-- The one question the app cannot answer for itself. BDO keeps a
                 character's numeric id when a slot is deleted and refilled, so
                 "the file changed" means either a restyle or a stranger — and
                 the bytes look the same in both cases. Answering it wrong
                 either throws away a design or leaves someone else wearing it,
                 so it is asked once, per tile, before anything is touched. -->
            <div class="alert">
              <p class="alerthead">
                {app.changedTiles.length} portrait(s) changed in the game since you were last here.
              </p>
              <p class="empty">
                Same character with a new look, or a different character in that slot? Nothing is
                touched until you say.
              </p>
              <ul>
                {#each app.changedTiles as id (id)}
                  <li>
                    <canvas class="thumb" width="31" height="40" use:portrait={id}></canvas>
                    <button class="name">
                      {id}
                      <span class="usage">
                        {tileProject(id)?.name ?? "unsorted"} ·
                        {tileLayers(id).length} layer(s)
                      </span>
                    </button>
                    <button title="Keep the layers on it" onclick={() => keepCharacter(id)}>
                      Same character
                    </button>
                    <button
                      title="Strip it and send it back to Unsorted"
                      onclick={() => replaceCharacter(id)}
                    >
                      New character
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
          <div class="cards">
            <button class="card inbox" onclick={() => enter("")}>
              <span class="cardname">
                Unsorted
                <!-- Ids this folder had never shown us before: a first run, or
                     characters made since the last one. Not a problem to solve
                     — just something that must not be missed in a list of
                     forty-four. -->
                {#if freshHere().length}<span class="badge">{freshHere().length} new</span>{/if}
              </span>
              <span class="cardsub">
                {inbox().length}
                {inbox().length === 1 ? "tile" : "tiles"} waiting
              </span>
              {@render thumbs(inbox())}
            </button>
            {#each projects() as project (project.id)}
              <button class="card" onclick={() => enter(project.id)}>
                <span class="cardname">{project.name}</span>
                <span class="cardsub">
                  {project.order.length} placed{#if project.shelf.length}
                    · {project.shelf.length} shelved{/if}
                </span>
                {@render thumbs(project.order)}
              </button>
            {/each}
          </div>
          {#if !projects().length}
            <p class="empty">
              Open Unsorted, pick the portraits of one account, then "Project from selection".
            </p>
          {/if}
        </div>
      {:else}
        <GridCanvas bind:this={grid} />
      {/if}
    </div>

    <aside bind:this={pane} onscroll={() => (scrolled = pane!.scrollTop > 200)}>
      {#if editing}
        <h2>Layers in the layout</h2>
        {#if !layoutLayers.length}
          <p class="empty">No layers.</p>
        {/if}
        {@render layerRows(layoutLayers, false, null)}
        <p class="empty">Right-click a layer to group, move, or rename.</p>
        {#if selectedLayoutLayer}
          <Properties layer={selectedLayoutLayer} inLayout />
        {/if}
      {:else}
        {#if wallLayers.length}
          <h2>Wall</h2>
          <ul>
            {#each wallLayers as layer (layer.id)}
              <li class:selected={app.selected === layer.id}>
                <button
                  class="eye"
                  title={layer.hidden ? "Show" : "Hide"}
                  onclick={() => toggleLayerHidden(layer.id)}
                >
                  {@render eyeIcon(!!layer.hidden)}
                </button>
                <button class="name" class:dimmed={layer.hidden} onclick={() => selectLayer(layer.id)}>
                  {layerLabel(layer)}
                </button>
                <button title="Delete" onclick={() => deleteLayer(layer.id)}>×</button>
              </li>
            {/each}
          </ul>
        {/if}

        <!-- One wall per project. The FaceTexture folder is shared by every
             account on the machine, so which portraits belong together is a
             thing only the user knows — the inbox is whatever no project has
             claimed, and it is where a newly created character turns up. -->
        <h2 class:spaced={wallLayers.length}>
          <button class="twisty inline" onclick={() => toggleOpen("projects")}>
            {open.has("projects") ? "▾" : "▸"}
          </button>
          Projects
        </h2>
        <ul class:collapsed={!open.has("projects")}>
          <li class:selected={!app.openProjectId}>
            <button class="name" onclick={() => enter("")}>
              Unsorted
              <span class="usage">
                {inbox().length} unassigned{#if !inbox().length} · all sorted{/if}
              </span>
            </button>
          </li>
          {#each projects() as project (project.id)}
            <li class:selected={app.openProjectId === project.id}>
              {#if renaming === project.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="rename"
                  autofocus
                  value={project.name}
                  onblur={(e) => {
                    void renameProject(project.id, e.currentTarget.value);
                    renaming = "";
                  }}
                  onkeydown={(e) => renameKey(e, project.name)}
                />
              {:else}
                <button
                  class="name"
                  onclick={() => enter(project.id)}
                  ondblclick={() => (renaming = project.id)}
                  title="Click opens this wall, double-click renames"
                >
                  {project.name}
                  <span class="usage">
                    {project.order.length} placed{#if project.shelf.length}
                      · {project.shelf.length} shelved{/if}
                  </span>
                </button>
              {/if}
              <button title="Delete project" onclick={() => removeProject(project.id, project.name)}
                >×</button
              >
            </li>
          {/each}
        </ul>
        <button
          class="wide"
          onclick={() => newProjectFrom("")}
          disabled={!freeCount() || !!app.busy}
          title="Builds a wall from the picked tiles that no project has claimed"
        >
          + New project{#if freeCount()}&nbsp;({freeCount()}){/if}
        </button>

        <!-- One library across every project: a design fits characters from
             any account, and keeping a copy per wall would mean editing the
             same frame twice. Collapsible, because that library is the list
             that grows without bound. -->
        <h2 class="spaced">
          <button class="twisty inline" onclick={() => toggleOpen("layouts")}>
            {open.has("layouts") ? "▾" : "▸"}
          </button>
          Layouts{#if layouts().length}&nbsp;({layouts().length}){/if}
        </h2>
        {#if !layouts().length}
          <p class="empty">None yet.</p>
        {/if}
        <ul class:collapsed={!open.has("layouts")}>
          {#each layouts() as layout (layout.id)}
            <li>
              {#if renaming === layout.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="rename"
                  autofocus
                  value={layout.name}
                  onblur={(e) => {
                    void renameLayout(layout.id, e.currentTarget.value);
                    renaming = "";
                  }}
                  onkeydown={(e) => renameKey(e, layout.name)}
                />
              {:else}
                <!-- Double-click renames, like a group row — and opening lives
                     on the pencil, not on the name. Both cannot share the
                     name: the first click of a double-click would open the
                     document, unmount this row, and the second click would
                     land on nothing, which is exactly how layouts were
                     unrenamable for a while. -->
                <button
                  class="name"
                  ondblclick={() => (renaming = layout.id)}
                  title="Double-click to rename"
                >
                  {layout.name}
                  <!-- Both numbers, because they answer different questions:
                       the stamps are what a refresh or a delete touches, the
                       tiles are how much of the wall wears the design. One
                       group of fifteen tiles used to read "stamped 1 time". -->
                  <span class="usage">
                    {layoutUsage(layout.id)
                      ? `${layoutUsage(layout.id)} stamp(s) · ${layoutTiles(layout.id)} tile(s)`
                      : "unused"}
                  </span>
                </button>
              {/if}
              <button title="Edit layout" onclick={() => openLayoutDoc(layout.id)}>✎</button>
              <button title="Duplicate" onclick={() => duplicateLayoutDoc(layout.id)}>⧉</button>
              <button title="Delete" onclick={() => removeLayout(layout.id, layout.name)}>×</button
              >
            </li>
          {/each}
        </ul>
        <button
          class="wide"
          onclick={() => newLayoutDoc(`Layout ${layouts().length + 1}`)}
          disabled={!app.dir || !!app.busy}
        >
          + New layout
        </button>

        {#if shelfIds().length}
          <!-- Collected but not placed. Sorting a wall is two jobs — decide
               which portraits belong to it, then decide where each one sits —
               and this is the pile between them. Drag a row onto the wall to
               give it a slot; it lands in front of whatever it is dropped on. -->
          <h2 class="spaced">Shelf</h2>
          <ul>
            {#each shelfIds() as id (id)}
              <li
                class="shelfrow"
                draggable="true"
                ondragstart={(e) => {
                  dragTile = id;
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                }}
                ondragend={() => (dragTile = "")}
              >
                <canvas class="thumb" width="31" height="40" use:portrait={id}></canvas>
                <button
                  class="name"
                  onclick={(e) => toggleTile(id, { ctrl: e.ctrlKey, shift: e.shiftKey })}>{id}</button
                >
                <button title="Put it at the end of the wall" onclick={() => placeTileAt(id, null)}
                  >↦</button
                >
              </li>
            {/each}
          </ul>
          <p class="empty">Drag onto the wall to choose the slot.</p>
        {/if}

        <!-- The tiles of whichever wall is showing, with any cosmetic drawers
             first. A drawer is a place to put finished portraits so the list
             stays scannable — it renders nothing and owns nothing. -->
        <h2 class="spaced">Tiles</h2>
        {#each folders() as folder (folder.id)}
          <div
            class="group"
            role="presentation"
            onmouseenter={() => (app.hoverFolder = folder.id)}
            onmouseleave={() => (app.hoverFolder = "")}
          >
            <div class="grouphead">
              <button class="twisty" onclick={() => toggleOpen(folder.id)}>
                {open.has(folder.id) ? "▾" : "▸"}
              </button>
              {#if renaming === folder.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="rename"
                  autofocus
                  value={folder.name}
                  onblur={(e) => {
                    void renameFolder(folder.id, e.currentTarget.value);
                    renaming = "";
                  }}
                  onkeydown={(e) => renameKey(e, folder.name)}
                />
              {:else}
                <button
                  class="name"
                  onclick={() => toggleOpen(folder.id)}
                  ondblclick={() => (renaming = folder.id)}
                  title="Double-click to rename · hover outlines its tiles"
                >
                  {folder.name}
                  <span class="usage">{folder.tiles.length} tiles</span>
                </button>
              {/if}
              <button
                title="Put the picked tiles in here"
                disabled={!app.selectedTiles.length}
                onclick={() => {
                  for (const id of app.selectedTiles) void fileTile(id, folder.id);
                }}>+</button
              >
              <!-- Dissolve, not delete: the tiles keep their slots and every
                   layer on them. That is the whole difference from the group
                   this replaced, where the same click threw artwork away. -->
              <button title="Dissolve — the tiles stay" onclick={() => removeFolder(folder.id)}
                >×</button
              >
            </div>
            {#if open.has(folder.id)}
              <ul class="indent">
                {#each folder.tiles as id (id)}
                  <li class:selected={app.selectedTiles.includes(id)}>
                    <button
                      class="name"
                      onclick={(e) => toggleTile(id, { ctrl: e.ctrlKey, shift: e.shiftKey })}>{id}</button
                    >
                    <button title="Back to the loose pile" onclick={() => fileTile(id, "")}>↓</button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/each}

        {#if openProject()}
          <button
            class="wide"
            onclick={() => newFolderHere("")}
            disabled={!!app.busy}
            title="A drawer for finished tiles, so the list stays short"
          >
            + New folder{#if app.selectedTiles.length}&nbsp;({app.selectedTiles.length}){/if}
          </button>
        {/if}

        <div class="group">
          <div class="grouphead">
            <button class="twisty" onclick={() => toggleOpen("tiles")}>
              {open.has("tiles") ? "▾" : "▸"}
            </button>
            <button class="name" onclick={() => toggleOpen("tiles")}>
              {app.openProjectId ? "On this wall" : "Unsorted"}
              <span class="usage">{looseIds().length} · assign one at a time</span>
            </button>
          </div>

          {#if open.has("tiles")}
            <div class="indent">
              {#each looseIds() as id (id)}
                {@const own = stampsOf(tileLayers(id))}
                {@const owner = tileProject(id)}
                <div
                  class="group"
                  role="presentation"
                  data-tile={id}
                  onmouseenter={() => (app.hoverTile = id)}
                  onmouseleave={() => app.hoverTile === id && (app.hoverTile = "")}
                >
                  <div class="grouphead" class:selected={app.selectedTiles.includes(id)}>
                    <button class="twisty" onclick={() => toggleTileRow(id)}>
                      {open.has(id) ? "▾" : "▸"}
                    </button>
                    <button
                      class="name"
                      onclick={(e) => toggleTile(id, { ctrl: e.ctrlKey, shift: e.shiftKey })}
                      title="Picks this tile on the wall · Ctrl adds one, Shift takes the range"
                    >
                      {id}
                      <span class="usage">
                        {own.length ? `${own.length} layout(s)` : owner ? "no layout" : "unassigned"}
                      </span>
                    </button>
                    {#if owner && app.openProjectId}
                      <!-- Off the grid, not out of the project: the tile keeps
                           every layer and only gives up its slot, and the tiles
                           after it close the gap. -->
                      <button title="Off the wall, onto the shelf" onclick={() => unplace(id)}
                        >↩</button
                      >
                    {/if}
                  </div>

                  {#if open.has(id)}
                    {@render stampRows(
                      own,
                      (moving, beforeId) => void dropTileLayer(id, moving, beforeId),
                    )}
                    <select
                      class="indent assign"
                      disabled={!layouts().length || !!app.busy}
                      onchange={(e) => {
                        const layoutId = e.currentTarget.value;
                        e.currentTarget.value = "";
                        if (layoutId) void assignTileLayout(id, layoutId);
                      }}
                    >
                      <option value="">+ Assign layout…</option>
                      {#each layouts() as layout (layout.id)}
                        <option value={layout.id}>{layout.name}</option>
                      {/each}
                    </select>

                    <!-- What this tile alone says and shows. In the row rather
                         than in a panel below the list: with forty-four rows,
                         editing the first one meant scrolling past all of them
                         and back. Here the fields cannot be further away than
                         the row they belong to. -->
                    {#each tileCaptions(id) as caption (caption.id)}
                      <label class="field indent">
                        <span>{layerLabel(caption)}</span>
                        <!-- The default shows as a placeholder, not as a value:
                             typing over a real value and clearing a field look
                             identical, and only one of them should mean "this
                             tile says nothing". -->
                        <input
                          value={tileText(id, caption.id) ?? ""}
                          placeholder={caption.text}
                          oninput={(e) => void setTileText(id, caption.id, e.currentTarget.value)}
                        />
                        <button
                          title="Use the layer's default text again"
                          disabled={tileText(id, caption.id) === undefined}
                          onclick={() => void clearTileText(id, caption.id)}>↺</button
                        >
                      </label>
                    {/each}

                    {#each tileImages(id) as pic (pic.id)}
                      {@const chosen = tileAsset(id, pic.id)}
                      <p class="sub">{layerLabel(pic)}</p>
                      <!-- A gallery rather than a file dialog per tile: class
                           logos repeat across a wall, so from the second tile
                           on the picture is almost always one already
                           imported. The dialog stays, as the "+" that feeds
                           the gallery. -->
                      <div class="gallery indent">
                        {#each tileImageChoices(id, pic.id) as asset (asset)}
                          <button
                            class="swatch"
                            class:on={(chosen ?? pic.asset) === asset}
                            title={asset === pic.asset
                              ? "The layer's own picture"
                              : "Use this picture"}
                            onclick={() => void setTileAsset(id, pic.id, asset)}
                          >
                            {#await assetUrl(asset) then url}
                              <img src={url} alt="" />
                            {/await}
                          </button>
                        {/each}
                        <button
                          class="swatch"
                          title="Pick a new picture…"
                          onclick={() => void pickTileImage(id, pic.id)}
                        >
                          +
                        </button>
                        <!-- A circle with a slash: the sign for "none of them",
                             which is a choice here and not the absence of one. -->
                        <button
                          class="swatch none"
                          class:on={chosen === ""}
                          title="Show no picture on this tile"
                          onclick={() => void setTileAsset(id, pic.id, "")}
                        >
                          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                            <circle
                              cx="9"
                              cy="9"
                              r="7"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.6"
                            />
                            <line
                              x1="4"
                              y1="14"
                              x2="14"
                              y2="4"
                              stroke="currentColor"
                              stroke-width="1.6"
                            />
                          </svg>
                        </button>
                        <button
                          class="swatch"
                          title="Use the layer's own picture again"
                          disabled={chosen === undefined}
                          onclick={() => void clearTileAsset(id, pic.id)}>↺</button
                        >
                      </div>
                    {/each}
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>

      {/if}
      <!-- The way back up. Only once there is a way back: a button that is
           always there is furniture, one that appears when you have travelled
           says something. -->
      {#if scrolled}
        <button
          class="totop"
          title="Back to the top"
          onclick={() => pane?.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M7 11.5V3M3.2 6.6 7 2.8l3.8 3.8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      {/if}
    </aside>
  </div>

  {#if menu}
    <ContextMenu {...menu} onclose={() => (menu = null)} />
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0d1114;
    color: #cfd6dc;
    font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
  }
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .stage {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  /* While a shelved tile is being carried, so the wall reads as a target
     rather than as scenery the drag happens to be over. */
  .stage.dropping {
    outline: 2px dashed #78dcff;
    outline-offset: -4px;
  }
  .home {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 24px;
  }
  .cards {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 16px;
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    width: 210px;
    padding: 12px;
    text-align: left;
  }
  .card:hover {
    border-color: #78dcff;
  }
  /* The inbox is where a newly created character turns up, so it leads and
     says so — the projects are arrangements, this one is a to-do. */
  .card.inbox {
    border-color: #3f5a68;
    background: #162026;
  }
  .cardname {
    font-size: 14px;
    color: #cdeeff;
  }
  .cardsub {
    color: #8b979f;
    font-size: 11px;
  }
  .strip {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-top: 6px;
  }
  .thumb {
    flex: none;
    border-radius: 2px;
    background: #0d1114;
  }
  .more {
    color: #6c777e;
    font-size: 11px;
  }
  .shelfrow {
    cursor: grab;
  }
  /* Amber, not the app's blue: this is the one thing on the page that wants an
     answer before anything else is worth doing. */
  .alert {
    max-width: 640px;
    margin-bottom: 16px;
    padding: 12px;
    border: 1px solid #6b5320;
    border-radius: 4px;
    background: #1e1a10;
  }
  .alerthead {
    margin: 0 0 4px;
    color: #ffc45c;
  }
  .alert ul {
    margin-top: 8px;
  }
  .badge {
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 8px;
    background: #2b4a5a;
    color: #cdeeff;
    font-size: 10px;
  }
  /* Hidden rather than unrendered: the list is short enough that keeping it in
     the DOM costs nothing, and the rows keep their scroll position. */
  ul.collapsed {
    display: none;
  }
  h2 .twisty.inline {
    height: auto;
    min-width: 16px;
    padding: 0;
    font-size: 11px;
    vertical-align: baseline;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid #232b31;
  }
  button {
    font: inherit;
    padding: 4px 10px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #1b2228;
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .status {
    margin-left: auto;
    color: #8b979f;
  }
  .docs {
    display: flex;
    gap: 2px;
    margin-right: 6px;
    padding-right: 8px;
    border-right: 1px solid #232b31;
  }
  .tools {
    flex: none;
    display: grid;
    grid-template-columns: repeat(2, 38px);
    gap: 3px;
    align-content: start;
    padding: 8px;
    border-right: 1px solid #232b31;
    overflow-y: auto;
  }
  .tools button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 32px;
    padding: 0;
    font: 15px/1 ui-sans-serif, system-ui, sans-serif;
    color: #cfd6dc;
  }
  .tools button:disabled {
    opacity: 0.35;
  }
  .tools .gap {
    grid-column: 1 / -1;
    height: 6px;
  }
  .docs button.active {
    border-color: #78dcff;
    background: #223039;
    color: #cdeeff;
  }
  .link {
    padding: 0 4px;
    border-color: transparent;
    background: none;
    color: #78dcff;
    text-decoration: underline;
  }
  aside {
    position: relative;
    width: 300px;
    flex: none;
    overflow-y: auto;
    padding: 8px;
    border-left: 1px solid #232b31;
  }
  /* The browser's own scrollbar is a bright slab in a dark app. Chromium draws
     this one, and Chromium is the only engine this ships on. */
  aside::-webkit-scrollbar,
  .stage ::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }
  aside::-webkit-scrollbar-track,
  .stage ::-webkit-scrollbar-track {
    background: transparent;
  }
  aside::-webkit-scrollbar-thumb,
  .stage ::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 6px;
    background: #313c44;
    background-clip: content-box;
  }
  aside::-webkit-scrollbar-thumb:hover,
  .stage ::-webkit-scrollbar-thumb:hover {
    background: #47555f;
    background-clip: content-box;
  }
  .totop {
    position: sticky;
    bottom: 4px;
    left: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid #3a444c;
    border-radius: 13px;
    background: #1b2228;
    color: #8b979f;
    cursor: pointer;
  }
  .totop:hover {
    color: #d6dde2;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #8b979f;
  }
  h2.spaced {
    margin-top: 18px;
  }
  .empty {
    margin: 0;
    color: #6c777e;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: 3px;
  }
  li.selected {
    background: #223039;
  }
  /* A line where the row would land, and a frame when it would land inside —
     an insertion point has to be visible before the mouse is released or the
     drop is a guess. box-shadow rather than a border, so nothing shifts by a
     pixel as the marker moves from row to row. */
  li.drop-before {
    box-shadow: inset 0 2px 0 #78dcff;
  }
  li.drop-after {
    box-shadow: inset 0 -2px 0 #78dcff;
  }
  li.drop-into {
    box-shadow: inset 0 0 0 2px #78dcff;
  }
  li[draggable="true"] {
    cursor: grab;
  }
  /* The same target size as the toolbar. A row's controls are hit as often as
     a tool is, and they were half the size — 32px is one number for the whole
     app rather than one per panel. The name button is exempt: it stretches to
     the row and its height comes from the line. */
  li button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    height: 32px;
    padding: 0 6px;
    font-size: 15px;
  }
  .name {
    flex: 1;
    min-width: 0;
    /* Left-aligned and elastic, unlike the square icon buttons above — and
       block, so a two-line row (name plus its usage count) is not squashed
       into one flex line. */
    display: block;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: inherit;
    border-color: transparent;
    background: none;
  }
  .dimmed {
    color: #6c777e;
  }
  .usage {
    display: block;
    color: #6c777e;
    font-size: 11px;
  }
  .wide {
    width: 100%;
    height: 32px;
    margin-top: 6px;
  }
  .eye {
    border-color: transparent;
    background: none;
  }
  .group {
    margin-bottom: 6px;
    border-bottom: 1px solid #1a2126;
  }
  /* On the head, not the whole group. Tile rows are groups nested inside the
     section's group, so a hover on one row also hovered its ancestor and the
     entire block lit up — which read as "everything is marked". */
  .grouphead:hover {
    background: #141b21;
  }
  .grouphead.selected {
    background: #223039;
  }
  .grouphead {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
  }
  .grouphead button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    height: 32px;
    padding: 0 6px;
    font-size: 15px;
  }
  .grouphead .name {
    display: block;
    height: auto;
    color: #78dcff;
  }
  .twisty {
    min-width: 22px;
    padding: 0;
    border-color: transparent;
    background: none;
    color: #8b979f;
  }
  /* Thumbnails on the app's chequerboard rather than on flat colour: a class
     logo is usually transparent, and on a dark panel a dark logo is a dark
     square. */
  .gallery {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-bottom: 6px;
  }
  .swatch {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 2px;
    background:
      linear-gradient(45deg, #20272d 25%, transparent 25%) 0 0 / 10px 10px,
      linear-gradient(-45deg, #20272d 25%, transparent 25%) 0 5px / 10px 10px,
      #171d22;
  }
  .swatch img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .swatch.on {
    border-color: #78dcff;
    box-shadow: inset 0 0 0 1px #78dcff;
  }
  .swatch.none {
    color: #8b979f;
  }
  /* The gallery's label and the wording field's label name the same kind of
     thing — a layer on this tile — so they are set the same and start on the
     same column. It used to be a small-caps subtitle sitting one notch to the
     left, which read as a heading over the row rather than a label in it. */
  .sub {
    margin: 4px 0 2px 18px;
    color: #8b979f;
    font-size: 11px;
  }
  .indent {
    margin-left: 18px;
  }
  .assign {
    width: calc(100% - 18px);
    height: 32px;
    margin: 2px 0 6px;
    font: inherit;
    padding: 0 6px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #1b2228;
    color: #8b979f;
  }
  .rename {
    flex: 1;
    min-width: 0;
    height: 32px;
    font: inherit;
    padding: 0 6px;
    border: 1px solid #78dcff;
    border-radius: 3px;
    background: #0d1114;
    color: inherit;
  }
  .dirty {
    color: #ffc45c;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 4px;
  }
  .field > span:first-child {
    flex: none;
    width: 56px;
    overflow: hidden;
    color: #8b979f;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .field input {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 2px 4px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #0d1114;
    color: inherit;
  }
</style>
