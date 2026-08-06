<script lang="ts">
  /* Bare shell, still. Two documents live here — the wall and one open Layout —
   * and which is showing decides both the canvas in the middle and what the
   * side panel lists. The tool strip and dense token set land in M4; this
   * exists to drive the layout/stamp path end to end. */
  import { onMount } from "svelte";
  import { ask } from "./lib/platform";

  import GridCanvas from "./GridCanvas.svelte";
  import LayoutCanvas from "./LayoutCanvas.svelte";
  import {
    addGridImage,
    addLayoutImage,
    addTilesToGroup,
    app,
    assignLayout,
    bakeMosaic,
    canBakeMosaic,
    canGroupLayers,
    canSaveLayout,
    canStampLayout,
    clearTiles,
    closeLayoutDoc,
    deleteGroup,
    deleteLayer,
    deleteLayoutDoc,
    deleteLayoutLayer,
    freeCount,
    groupLayoutLayers,
    groups,
    layoutUsage,
    layouts,
    moveLayer,
    moveLayoutLayer,
    newGroup,
    newLayoutDoc,
    openFolder,
    openLayout,
    openLayoutDoc,
    redoEdit,
    redoable,
    removeTileFromGroup,
    renameGroup,
    renameLayer,
    renameLayout,
    saveLayout,
    saveToGame,
    selectLayer,
    stampLayout,
    toggleLayerHidden,
    toggleLayerLocked,
    toggleLayoutLayerHidden,
    toggleLayoutPick,
    undoEdit,
    undoable,
  } from "./lib/editor.svelte";
  import { layerLabel, layoutNeedsRestamp, type Layer } from "./lib/model";

  const editing = $derived(openLayout());

  /* The FaceTexture folder is the only one this tool ever edits, so asking
     which one on every start was a dialog with one right answer. */
  onMount(() => void openFolder());

  function shortcut(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
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

  async function removeGroup(id: string, name: string, stamps: number) {
    if (
      stamps &&
      !(await ask(`„${name}" hat ${stamps} Layout(s) auf ihren Kacheln. Die gehen mit weg.`, {
        title: "Gruppe löschen?",
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
</script>

<svelte:window onkeydown={shortcut} />

<!-- One Layout row per layer, recursing into groups. A snippet rather than a
     component because it needs nothing but the list it draws, and a component
     would mean threading every action through props. -->
{#snippet layerRows(rows: Layer[], nested: boolean)}
  <ul class:indent={nested}>
    {#each rows as layer (layer.id)}
      <li class:selected={app.layoutSelection.includes(layer.id)}>
        <button
          class="eye"
          title={layer.hidden ? "Einblenden" : "Ausblenden"}
          onclick={() => toggleLayoutLayerHidden(layer.id)}
        >
          {layer.hidden ? "○" : "●"}
        </button>
        <button
          class="eye"
          title={layer.locked ? "Entsperren" : "Sperren"}
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
            title="Strg-Klick wählt mehrere, Doppelklick benennt um"
          >
            {layer.kind === "group" ? "▾ " : ""}{layerLabel(layer)}
          </button>
        {/if}
        <button title="Nach oben" onclick={() => moveLayoutLayer(layer.id, true)}>↑</button>
        <button title="Nach unten" onclick={() => moveLayoutLayer(layer.id, false)}>↓</button>
        <button
          title={layer.kind === "group" ? "Gruppe auflösen, Ebenen bleiben" : "Löschen"}
          onclick={() => deleteLayoutLayer(layer.id)}>×</button
        >
      </li>
      {#if layer.kind === "group"}
        {@render layerRows([...layer.children].reverse(), true)}
      {/if}
    {/each}
  </ul>
{/snippet}

<main>
  <header>
    <div class="docs" role="group" aria-label="Dokument">
      <button class:active={!editing} onclick={closeLayoutDoc} disabled={!app.dir}>Wand</button>
      {#if editing}
        <button class="active" title="Esc schließt">{editing.name}</button>
      {/if}
    </div>

    {#if editing}
      <button onclick={addLayoutImage} disabled={!!app.busy}>Bild einfügen</button>
      <button
        onclick={groupLayoutLayers}
        disabled={!canGroupLayers() || !!app.busy}
        title="Mehrere Ebenen mit Strg wählen, dann gruppieren"
      >
        Gruppieren
      </button>
      <button
        onclick={() => stampLayout(editing.id)}
        disabled={!canStampLayout() || !!app.busy}
        title="Rendert das Layout und legt es auf die gewählten Kacheln"
      >
        Auf Auswahl stempeln
        {#if app.selectedTiles.length}({app.selectedTiles.length}){/if}
      </button>
      <button
        onclick={() => saveLayout(editing.id)}
        disabled={!canSaveLayout(editing.id) || !!app.busy}
        title={layoutUsage(editing.id)
          ? `Überträgt die Änderungen auf ${layoutUsage(editing.id)} Stempel`
          : "Noch nirgends gestempelt"}
      >
        <!-- Not "Speichern": the Layout is written to disk on every edit, so a
             save button would promise something that already happened. What
             this does is re-render and swap the picture in every stamp. -->
        Stempel aktualisieren{#if layoutUsage(editing.id)}&nbsp;({layoutUsage(editing.id)}){/if}
      </button>
    {:else}
      <button onclick={newGroup} disabled={!freeCount() || !!app.busy}>
        Gruppe aus Auswahl
        {#if freeCount()}({freeCount()}){/if}
      </button>
      <button onclick={addGridImage} disabled={!app.dir || !!app.busy}>Bild über das Grid</button>
      <button
        onclick={bakeMosaic}
        disabled={!canBakeMosaic() || !!app.busy}
        title="Backt das gewählte Wandbild in jede vollständig bedeckte Kachel; danach kein Objekt mehr"
      >
        Anwenden
      </button>
    {/if}

    <button onclick={undoEdit} disabled={!undoable()} title="Strg+Z">Rückgängig</button>
    <button onclick={redoEdit} disabled={!redoable()} title="Strg+Y">Wiederholen</button>
    {#if !editing}
      <button onclick={saveToGame} disabled={!app.dir || !!app.busy}>Ins Spiel schreiben</button>
    {/if}

    <span class="status">
      {#if app.busy}
        {app.busy}…
      {:else if app.error}
        {app.error}
      {:else if editing && canSaveLayout(editing.id)}
        Gesichert &middot; Änderungen noch nicht auf den Kacheln
      {:else if editing}
        Gesichert{#if !app.selectedTiles.length}
          &middot; Kacheln auf der Wand wählen, um zu stempeln
        {/if}
      {:else if app.selectedTiles.length}
        {app.selectedTiles.length} gewählt{#if freeCount() < app.selectedTiles.length}, {freeCount()}
          davon frei{/if}
        <button class="link" onclick={clearTiles}>aufheben</button>
      {:else if app.dir}
        {app.manifest.order.length} Kacheln &middot; klicken zum Wählen, Strg für mehrere, ziehen zum Tauschen
      {/if}
    </span>
  </header>

  <div class="body">
    {#if editing}
      <LayoutCanvas />
    {:else}
      <GridCanvas />
    {/if}

    <aside>
      {#if editing}
        <h2>Ebenen im Layout</h2>
        {#if !layoutLayers.length}
          <p class="empty">Keine Ebenen.</p>
        {/if}
        {@render layerRows(layoutLayers, false)}
      {:else}
        {#if wallLayers.length}
          <h2>Wand</h2>
          <ul>
            {#each wallLayers as layer (layer.id)}
              <li class:selected={app.selected === layer.id}>
                <button
                  class="eye"
                  title={layer.hidden ? "Einblenden" : "Ausblenden"}
                  onclick={() => toggleLayerHidden(layer.id)}
                >
                  {layer.hidden ? "○" : "●"}
                </button>
                <button class="name" class:dimmed={layer.hidden} onclick={() => selectLayer(layer.id)}>
                  {layerLabel(layer)}
                </button>
                <button title="Löschen" onclick={() => deleteLayer(layer.id)}>×</button>
              </li>
            {/each}
          </ul>
        {/if}

        <h2 class:spaced={wallLayers.length}>Gruppen</h2>
        {#if !groups().length}
          <p class="empty">Kacheln wählen, dann „Gruppe aus Auswahl".</p>
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
                  title="Doppelklick zum Umbenennen"
                >
                  {group.name}
                  <span class="usage">{tiles.length} Kacheln · {group.layers.length} Layouts</span>
                </button>
              {/if}
              <button
                title="Gewählte freie Kacheln hinzufügen"
                disabled={!freeCount()}
                onclick={() => addTilesToGroup(group.id)}>+</button
              >
              <button
                title="Gruppe löschen"
                onclick={() => removeGroup(group.id, group.name, group.layers.length)}>×</button
              >
            </div>

            {#if open.has(group.id)}
              <p class="sub">Kacheln</p>
              {#if !tiles.length}
                <p class="empty indent">Keine — Kacheln wählen, dann „+".</p>
              {/if}
              <ul class="indent">
                {#each tiles as id (id)}
                  <li class:selected={app.selectedTiles.includes(id)}>
                    <button class="name" onclick={() => (app.selectedTiles = [id])}>{id}</button>
                    <button title="Aus Gruppe entfernen" onclick={() => removeTileFromGroup(group.id, id)}
                      >×</button
                    >
                  </li>
                {/each}
              </ul>

              <p class="sub">Ebenen</p>
              {#if !group.layers.length}
                <p class="empty indent">Kein Layout zugewiesen.</p>
              {/if}
              <ul class="indent">
                {#each [...group.layers].reverse() as layer (layer.id)}
                  <li class:selected={app.selected === layer.id}>
                    <button
                      class="eye"
                      title={layer.hidden ? "Einblenden" : "Ausblenden"}
                      onclick={() => toggleLayerHidden(layer.id)}
                    >
                      {layer.hidden ? "○" : "●"}
                    </button>
                    <button
                      class="eye"
                      title={layer.locked ? "Entsperren" : "Sperren"}
                      onclick={() => toggleLayerLocked(layer.id)}
                    >
                      {layer.locked ? "🔒" : "🔓"}
                    </button>
                    <button
                      class="name"
                      class:dimmed={layer.hidden}
                      onclick={() => selectLayer(layer.id)}
                      ondblclick={() =>
                        layer.kind === "image" && layer.layoutId && openLayoutDoc(layer.layoutId)}
                      title="Doppelklick öffnet das Layout"
                    >
<!-- Marker before the name, not after: the name is what gets
                           ellipsised when the row runs out of width, and a dot
                           hidden behind "…" is the same as no dot at all. -->{#if stampDirty(layer)}<span
                          class="dirty"
                          title="Layout geändert — im Layout speichern">●&nbsp;</span
                        >{/if}{stampName(layer)}
                    </button>
                    <button title="Nach oben" onclick={() => moveLayer(layer.id, true)}>↑</button>
                    <button title="Nach unten" onclick={() => moveLayer(layer.id, false)}>↓</button>
                    <button title="Löschen" onclick={() => deleteLayer(layer.id)}>×</button>
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
                <option value="">+ Layout zuweisen…</option>
                {#each layouts() as layout (layout.id)}
                  <option value={layout.id}>{layout.name}</option>
                {/each}
              </select>
            {/if}
          </div>
        {/each}

        <h2 class="spaced">Layouts</h2>
        {#if !layouts().length}
          <p class="empty">Noch keins.</p>
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
                <button
                  class="name"
                  onclick={() => openLayoutDoc(layout.id)}
                  ondblclick={() => (renaming = layout.id)}
                  title="Klick öffnet, Doppelklick benennt um"
                >
                  {layout.name}
                  <span class="usage">
                    {layoutUsage(layout.id) ? `${layoutUsage(layout.id)}× gestempelt` : "nicht benutzt"}
                  </span>
                </button>
              {/if}
              <button title="Löschen" onclick={() => deleteLayoutDoc(layout.id)}>×</button>
            </li>
          {/each}
        </ul>
        <button
          class="wide"
          onclick={() => newLayoutDoc(`Layout ${layouts().length + 1}`)}
          disabled={!app.dir || !!app.busy}
        >
          + Neues Layout
        </button>
      {/if}
    </aside>
  </div>
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
</style>
