<script lang="ts">
  /* Bare shell, still. Two documents live here — the wall and one open Layout —
   * and which is showing decides both the canvas in the middle and what the
   * side panel lists. The tool strip and dense token set land in M4; this
   * exists to drive the layout/stamp path end to end. */
  import { onMount } from "svelte";
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
    addTilesToGroup,
    app,
    assignLayout,
    bakeMosaic,
    canBakeMosaic,
    canGroupLayers,
    canSaveLayout,
    claimedCount,
    clearTileText,
    clearTiles,
    closeLayoutDoc,
    deleteGroup,
    deleteLayer,
    deleteLayoutDoc,
    deleteLayoutLayer,
    dropGroupLayer,
    dropLayoutLayer,
    duplicateLayoutDoc,
    endGesture,
    freeCount,
    groupLayoutLayers,
    groups,
    layoutGroups,
    layoutTiles,
    layoutUsage,
    layouts,
    moveLayersIntoGroup,
    newGroup,
    newLayoutDoc,
    openFolder,
    openLayout,
    openLayoutDoc,
    redoEdit,
    redoable,
    releaseSelectedTiles,
    removeTileFromGroup,
    renameGroup,
    renameLayer,
    renameLayout,
    saveLayout,
    saveToGame,
    selectLayer,
    selectLayoutLayer,
    setTileText,
    tileCaptions,
    tileText,
    toggleLayerHidden,
    toggleLayerLocked,
    toggleLayoutLayerHidden,
    toggleLayoutPick,
    undoEdit,
    undoable,
  } from "./lib/editor.svelte";
  import { isTyping } from "./lib/geometry";
  import { findLayer, layerLabel, layoutNeedsRestamp, type Layer } from "./lib/model";

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
  let open = $state(new Set<string>());
  const toggleOpen = (id: string) => {
    open.has(id) ? open.delete(id) : open.add(id);
    open = new Set(open);
  };

  /** The row being renamed, "" for none. One at a time by construction. */
  let renaming = $state("");

  /** The wall canvas, for the one thing App needs from it: which tile is under
   *  a right-click. */
  let grid: GridCanvas | undefined = $state();

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

  /** Deleting a Layout leaves its stamps behind as pictures nothing owns —
   *  they keep rendering, but the row falls back to the asset hash and there
   *  is no way back except undo. Worth the same warning a group gets. */
  async function removeLayout(id: string, name: string) {
    const used = layoutUsage(id);
    if (
      used &&
      !(await ask(
        // Both units again: the pictures left behind are counted per group,
        // but what the deletion is visible on is tiles.
        `"${name}" is stamped on ${used} group(s), ${layoutTiles(id)} tile(s). ` +
          `The stamps stay behind as nameless pictures.`,
        { title: "Delete layout?", kind: "warning" },
      ))
    )
      return;
    await deleteLayoutDoc(id);
  }

  async function removeGroup(id: string, name: string, stamps: number) {
    if (
      stamps &&
      !(await ask(`"${name}" has ${stamps} layout(s) on its tiles. They go with it.`, {
        title: "Delete group?",
        kind: "warning",
      }))
    )
      return;
    await deleteGroup(id);
  }

  /** A stamp shows its Layout's name; anything else falls back to layerLabel. */
  const stampName = (l: Layer) =>
    (l.kind === "image" && l.layoutId && layouts().find((x) => x.id === l.layoutId)?.name) ||
    layerLabel(l);

  const stampDirty = (l: Layer) => {
    if (l.kind !== "image" || !l.layoutId) return false;
    const layout = layouts().find((x) => x.id === l.layoutId);
    return !!layout && layoutNeedsRestamp(layout);
  };

  /** The wall picture, if one is placed — it lives in an "all" overlay, which
   *  is not a group, so it gets its own little section. */
  const wallLayers = $derived(
    app.manifest.overlays.filter((o) => o.tiles === "all").flatMap((o) => [...o.layers].reverse()),
  );

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
    const claimed = claimedCount();
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "New group from selection", run: () => void newGroup(), disabled: !freeCount() },
        ...(groups().length ? [{ separator: true } as Item] : []),
        ...groups().map((g) => ({
          label: `Add to "${g.name}"`,
          run: () => void addTilesToGroup(g.id),
          disabled: !freeCount(),
        })),
        ...(claimed
          ? [
              { separator: true } as Item,
              {
                label: claimed === 1 ? "Remove from group" : `Remove ${claimed} from group`,
                run: () => void releaseSelectedTiles(),
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
          {layer.hidden ? "○" : "●"}
        </button>
        <button
          class="eye"
          title={layer.locked ? "Unlock" : "Lock"}
          onclick={() => toggleLayerLocked(layer.id)}
        >
          {layer.locked ? "🔒" : "🔓"}
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

<main>
  <header>
    <div class="docs" role="group" aria-label="Document">
      <button class:active={!editing} onclick={closeLayoutDoc} disabled={!app.dir}>Wall</button>
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
      <button onclick={newGroup} disabled={!freeCount() || !!app.busy}>
        Group from selection
        {#if freeCount()}({freeCount()}){/if}
      </button>
      <button onclick={addGridImage} disabled={!app.dir || !!app.busy}>Image across the grid</button>
      <button
        onclick={bakeMosaic}
        disabled={!canBakeMosaic() || !!app.busy}
        title="Bakes the selected wall picture into every fully covered tile; no object remains"
      >
        Apply
      </button>
      <button onclick={saveToGame} disabled={!app.dir || !!app.busy}>Write to game</button>
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
          of them free{/if}
        <button class="link" onclick={clearTiles}>clear</button>
      {:else if app.dir}
        {app.manifest.order.length} tiles &middot; drag selects, Ctrl adds, Alt+drag swaps
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
    <div class="stage" oncontextmenucapture={wallMenu}>
      {#if editing}
        <LayoutCanvas bind:this={sheet} />
      {:else}
        <GridCanvas bind:this={grid} />
      {/if}
    </div>

    <aside>
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
                  {layer.hidden ? "○" : "●"}
                </button>
                <button class="name" class:dimmed={layer.hidden} onclick={() => selectLayer(layer.id)}>
                  {layerLabel(layer)}
                </button>
                <button title="Delete" onclick={() => deleteLayer(layer.id)}>×</button>
              </li>
            {/each}
          </ul>
        {/if}

        <h2 class:spaced={wallLayers.length}>Groups</h2>
        {#if !groups().length}
          <p class="empty">Select tiles, then "Group from selection".</p>
        {/if}

        {#each groups() as group (group.id)}
          {@const tiles = group.tiles === "all" ? [] : group.tiles}
          <!-- Hover outlines this group's tiles on the wall, so what a group
               holds is readable without clicking into it. -->
          <div
            class="group"
            role="presentation"
            onmouseenter={() => (app.hoverGroup = group.id)}
            onmouseleave={() => (app.hoverGroup = "")}
          >
            <div class="grouphead">
              <button class="twisty" onclick={() => toggleOpen(group.id)}>
                {open.has(group.id) ? "▾" : "▸"}
              </button>
              {#if renaming === group.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="rename"
                  autofocus
                  value={group.name}
                  onblur={(e) => {
                    void renameGroup(group.id, e.currentTarget.value);
                    renaming = "";
                  }}
                  onkeydown={(e) => renameKey(e, group.name)}
                />
              {:else}
                <button
                  class="name"
                  ondblclick={() => (renaming = group.id)}
                  onclick={() => toggleOpen(group.id)}
                  title="Double-click to rename"
                >
                  {group.name}
                  <!-- Stamps, not every layer: a live caption sits in here too,
                       and counting it made a group with one design read
                       "2 Layouts". -->
                  <span class="usage">
                    {tiles.length} tiles · {group.layers.filter((l) => l.kind === "image").length}
                    layouts
                  </span>
                </button>
              {/if}
              <button
                title="Add the picked free tiles"
                disabled={!freeCount()}
                onclick={() => addTilesToGroup(group.id)}>+</button
              >
              <button
                title="Delete group"
                onclick={() =>
                  removeGroup(
                    group.id,
                    group.name,
                    group.layers.filter((l) => l.kind === "image").length,
                  )}>×</button
              >
            </div>

            {#if open.has(group.id)}
              <p class="sub">Tiles</p>
              {#if !tiles.length}
                <p class="empty indent">None — pick tiles, then "+".</p>
              {/if}
              <ul class="indent">
                {#each tiles as id (id)}
                  <li class:selected={app.selectedTiles.includes(id)}>
                    <button class="name" onclick={() => (app.selectedTiles = [id])}>{id}</button>
                    <button title="Remove from group" onclick={() => removeTileFromGroup(group.id, id)}
                      >×</button
                    >
                  </li>
                {/each}
              </ul>

              <p class="sub">Layers</p>
              {#if !group.layers.length}
                <p class="empty indent">No layout assigned.</p>
              {/if}
              <!-- Live captions are left out on purpose. Their row offered
                   nothing the stamp row does not: the layer is held (a wall
                   edit would be overwritten by the next stamp update), its
                   double-click opened the same Layout, and the per-tile
                   wording lives in the "Text on …" panel. One row per
                   assigned Layout is the whole story. -->
              {@const stamps = [...group.layers]
                .reverse()
                .filter((l) => !(l.kind === "text" && l.layoutId))}
              <ul class="indent">
                {#each stamps as layer (layer.id)}
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
                      void dropGroupLayer(
                        group.id,
                        moving,
                        landing(stamps, spot.id, spot.where, null).beforeId,
                      );
                    }}
                  >
                    <button
                      class="eye"
                      title={layer.hidden ? "Show" : "Hide"}
                      onclick={() => toggleLayerHidden(layer.id)}
                    >
                      {layer.hidden ? "○" : "●"}
                    </button>
                    <!-- A layer a Layout put here is held whatever this says,
                         so it says so: the row used to show an open padlock on
                         something the canvas would not let you touch, and
                         clicking it changed nothing either way. -->
                    <button
                      class="eye"
                      disabled={!!layer.layoutId}
                      title={layer.layoutId
                        ? "Held by the layout — edit it there"
                        : layer.locked
                          ? "Entsperren"
                          : "Sperren"}
                      onclick={() => toggleLayerLocked(layer.id)}
                    >
                      {layer.layoutId || layer.locked ? "🔒" : "🔓"}
                    </button>
                    <button
                      class="name"
                      class:dimmed={layer.hidden}
                      onclick={() => selectLayer(layer.id)}
                      ondblclick={() => layer.layoutId && openLayoutDoc(layer.layoutId)}
                      title="Double-click opens the layout"
                    >
<!-- Marker before the name, not after: the name is what gets
                           ellipsised when the row runs out of width, and a dot
                           hidden behind "…" is the same as no dot at all. -->{#if stampDirty(layer)}<span
                          class="dirty"
                          title="Layout changed — press Update stamps">●&nbsp;</span
                        >{/if}{stampName(layer)}
                    </button>
                    <button title="Delete" onclick={() => deleteLayer(layer.id)}>×</button>
                  </li>
                {/each}
              </ul>

              <select
                class="indent assign"
                disabled={!layouts().length || !!app.busy}
                onchange={(e) => {
                  const id = e.currentTarget.value;
                  e.currentTarget.value = "";
                  if (id) void assignLayout(group.id, id);
                }}
              >
                <option value="">+ Assign layout…</option>
                {#each layouts() as layout (layout.id)}
                  <option value={layout.id}>{layout.name}</option>
                {/each}
              </select>
            {/if}
          </div>
        {/each}

        {#if tileCaptions().length}
          {@const tile = app.selectedTiles[0]}
          <h2 class="spaced">Text on {tile}</h2>
          {#each tileCaptions() as caption (caption.id)}
            <label class="field">
              <span>{layerLabel(caption)}</span>
              <!-- The default shows as a placeholder, not as a value: typing
                   over a real value and clearing a field look identical, and
                   only one of them should mean "this tile says nothing". -->
              <input
                value={tileText(tile, caption.id) ?? ""}
                placeholder={caption.text}
                oninput={(e) => void setTileText(tile, caption.id, e.currentTarget.value)}
              />
              <button
                title="Use the layer's default text again"
                disabled={tileText(tile, caption.id) === undefined}
                onclick={() => void clearTileText(tile, caption.id)}>↺</button
              >
            </label>
          {/each}
        {/if}

        <h2 class="spaced">Layouts</h2>
        {#if !layouts().length}
          <p class="empty">None yet.</p>
        {/if}
        <ul>
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
                       the groups are what a refresh or a delete touches, the
                       tiles are how much of the wall wears the design. One
                       group of fifteen tiles used to read "stamped 1 time". -->
                  <span class="usage">
                    {layoutUsage(layout.id)
                      ? `${layoutUsage(layout.id)} group(s) · ${layoutTiles(layout.id)} tile(s)`
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
    width: 220px;
    flex: none;
    overflow-y: auto;
    padding: 8px;
    border-left: 1px solid #232b31;
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
  li button {
    padding: 2px 5px;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .group:hover {
    background: #141b21;
  }
  .grouphead {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
  }
  .grouphead button {
    padding: 2px 5px;
  }
  .grouphead .name {
    color: #78dcff;
  }
  .twisty {
    width: 18px;
    padding: 2px 0;
    border-color: transparent;
    background: none;
    color: #8b979f;
  }
  .sub {
    margin: 4px 0 2px 18px;
    color: #6c777e;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .indent {
    margin-left: 18px;
  }
  .empty.indent {
    margin: 0 0 2px 18px;
  }
  .assign {
    width: calc(100% - 18px);
    margin: 2px 0 6px;
    font: inherit;
    padding: 2px 4px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #1b2228;
    color: #8b979f;
  }
  .rename {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 1px 4px;
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
