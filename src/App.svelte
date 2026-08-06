<script lang="ts">
  /* Bare shell, still. Two documents live here — the wall and one open Layout —
   * and which is showing decides both the canvas in the middle and what the
   * side panel lists. The tool strip and dense token set land in M4; this
   * exists to drive the layout/stamp path end to end. */
  import GridCanvas from "./GridCanvas.svelte";
  import LayoutCanvas from "./LayoutCanvas.svelte";
  import {
    addGridImage,
    addLayoutImage,
    app,
    assignHint,
    assignSelection,
    bakeMosaic,
    canAssign,
    canBakeMosaic,
    canRestrict,
    canStampLayout,
    clearTiles,
    closeLayoutDoc,
    deleteLayer,
    deleteLayoutDoc,
    deleteLayoutLayer,
    layoutUsage,
    layouts,
    moveLayer,
    moveLayoutLayer,
    newLayoutDoc,
    openLayout,
    openLayoutDoc,
    pickFolder,
    redoEdit,
    redoable,
    restrictToSelection,
    saveToGame,
    selectLayer,
    selectLayoutLayer,
    setMode,
    stampLayout,
    toggleLayerHidden,
    toggleLayoutLayerHidden,
    undoEdit,
    undoable,
    updateLayoutStamps,
  } from "./lib/editor.svelte";
  import { layerLabel } from "./lib/model";

  const editing = $derived(openLayout());

  function shortcut(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    const key = e.key.toLowerCase();

    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      if (key === "escape" && editing) closeLayoutDoc();
      // V and M only mean anything on the wall; a Layout has no tiles to pick.
      else if (key === "v" && !editing) setMode("layers");
      else if (key === "m" && !editing) setMode("tiles");
      else return;
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

  /* Grouped by overlay, topmost first within each. The assignment belongs to
     the overlay, not to a single layer, so restricting one row moves every row
     under the same heading — showing the grouping is what makes that legible
     instead of baffling. */
  const groups = $derived(
    [...app.manifest.overlays]
      .reverse()
      .map((overlay) => ({ overlay, layers: [...overlay.layers].reverse() }))
      .filter((g) => g.layers.length),
  );

  const layoutLayers = $derived(editing ? [...editing.layers].reverse() : []);
</script>

<svelte:window onkeydown={shortcut} />

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
        onclick={() => stampLayout(editing.id)}
        disabled={!canStampLayout() || !!app.busy}
        title="Rendert das Layout und legt es auf die gewählten Kacheln"
      >
        Auf Auswahl stempeln
        {#if app.selectedTiles.length}({app.selectedTiles.length}){/if}
      </button>
      <button
        onclick={() => updateLayoutStamps(editing.id)}
        disabled={!layoutUsage(editing.id) || !!app.busy}
        title="Rendert neu und frischt jeden vorhandenen Stempel dieses Layouts auf"
      >
        Stempel aktualisieren ({layoutUsage(editing.id)})
      </button>
    {:else}
      <div class="modes" role="group" aria-label="Werkzeug">
        <button class:active={app.mode === "layers"} onclick={() => setMode("layers")} title="V">
          Ebenen
        </button>
        <button class:active={app.mode === "tiles"} onclick={() => setMode("tiles")} title="M">
          Kacheln
        </button>
      </div>
      <button onclick={pickFolder} disabled={!!app.busy}>Ordner öffnen</button>
      <button onclick={addGridImage} disabled={!app.dir || !!app.busy}>Bild über das Grid</button>
      <button
        onclick={bakeMosaic}
        disabled={!canBakeMosaic() || !!app.busy}
        title="Backt das gewählte Wandbild in jede vollständig bedeckte Kachel; danach kein Objekt mehr"
      >
        Anwenden
      </button>
      <button onclick={() => assignSelection(true)} disabled={!canAssign(true)}>+ zur Ebene</button>
      <button onclick={() => assignSelection(false)} disabled={!canAssign(false)}>− von Ebene</button>
      <button onclick={restrictToSelection} disabled={!canRestrict()}>nur Auswahl</button>
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
      {:else if editing && !app.selectedTiles.length}
        Kacheln auf der Wand wählen, um zu stempeln
      {:else if assignHint()}
        {assignHint()}
      {:else if app.selectedTiles.length}
        {app.selectedTiles.length} von {app.manifest.order.length} Kacheln gewählt
        <button class="link" onclick={clearTiles}>aufheben</button>
      {:else if app.dir && app.mode === "tiles"}
        {app.manifest.order.length} Kacheln &middot; anklicken zum Wählen, Strg für mehrere
      {:else if app.dir}
        {app.manifest.order.length} Kacheln &middot; M für Kachelauswahl, V für Ebenen
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
        <ul>
          {#each layoutLayers as layer (layer.id)}
            <li class:selected={app.layoutSelected === layer.id}>
              <button
                class="eye"
                title={layer.hidden ? "Einblenden" : "Ausblenden"}
                onclick={() => toggleLayoutLayerHidden(layer.id)}
              >
                {layer.hidden ? "○" : "●"}
              </button>
              <button
                class="name"
                class:dimmed={layer.hidden}
                onclick={() => selectLayoutLayer(layer.id)}
              >
                {layerLabel(layer)}
              </button>
              <button title="Nach oben" onclick={() => moveLayoutLayer(layer.id, true)}>↑</button>
              <button title="Nach unten" onclick={() => moveLayoutLayer(layer.id, false)}>↓</button>
              <button title="Löschen" onclick={() => deleteLayoutLayer(layer.id)}>×</button>
            </li>
          {/each}
        </ul>
      {:else}
        <h2>Ebenen</h2>
        {#if !groups.length}
          <p class="empty">Keine Ebenen.</p>
        {/if}
        {#each groups as { overlay, layers: rows } (overlay.id)}
          <!-- The assignment, not overlay.name: the name is fixed at creation,
               so an overlay made from every tile still called itself "Alle
               Kacheln" after one was taken away. Renaming arrives later. -->
          <h3 title={overlay.name}>
            {overlay.tiles === "all" ? "alle Kacheln" : `${overlay.tiles.length} Kacheln`}
          </h3>
          <ul>
            {#each rows as layer (layer.id)}
              <li class:selected={app.selected === layer.id}>
                <button
                  class="eye"
                  title={layer.hidden ? "Einblenden" : "Ausblenden"}
                  onclick={() => toggleLayerHidden(layer.id)}
                >
                  {layer.hidden ? "○" : "●"}
                </button>
                <button class="name" class:dimmed={layer.hidden} onclick={() => selectLayer(layer.id)}>
                  {layerLabel(layer)}{layer.space === "grid" ? " · Grid" : ""}
                </button>
                <button title="Nach oben" onclick={() => moveLayer(layer.id, true)}>↑</button>
                <button title="Nach unten" onclick={() => moveLayer(layer.id, false)}>↓</button>
                <button title="Löschen" onclick={() => deleteLayer(layer.id)}>×</button>
              </li>
            {/each}
          </ul>
        {/each}

        <h2 class="spaced">Layouts</h2>
        {#if !layouts().length}
          <p class="empty">Noch keins.</p>
        {/if}
        <ul>
          {#each layouts() as layout (layout.id)}
            <li>
              <button class="name" onclick={() => openLayoutDoc(layout.id)}>
                {layout.name}
                <span class="usage">
                  {layoutUsage(layout.id)
                    ? `${layoutUsage(layout.id)}× gestempelt`
                    : "nicht benutzt"}
                </span>
              </button>
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
  .docs,
  .modes {
    display: flex;
    gap: 2px;
    margin-right: 6px;
    padding-right: 8px;
    border-right: 1px solid #232b31;
  }
  .docs button.active,
  .modes button.active {
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
  h3 {
    margin: 10px 0 3px;
    padding-bottom: 2px;
    border-bottom: 1px solid #232b31;
    color: #78dcff;
    font-size: 11px;
    font-weight: 500;
  }
  .eye {
    border-color: transparent;
    background: none;
  }
</style>
