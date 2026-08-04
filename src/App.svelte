<script lang="ts">
  /* M1 shell: deliberately bare. The panel system, the tool strip and the dense
   * token set land in M3 — this exists to exercise the canvas and the export
   * path end to end, plus the one thing the first real run proved unusable
   * without: seeing which layers exist. The old grid/editor/placer components
   * are still on disk, no longer reachable, and are deleted in M3. */
  import GridCanvas from "./GridCanvas.svelte";
  import {
    addGridImage,
    addImageToSelection,
    app,
    assignHint,
    assignSelection,
    canAssign,
    canRestrict,
    clearTiles,
    deleteLayer,
    layerRows,
    moveLayer,
    pickFolder,
    redoEdit,
    redoable,
    restrictToSelection,
    saveToGame,
    selectLayer,
    setMode,
    toggleLayerHidden,
    undoEdit,
    undoable,
  } from "./lib/editor.svelte";
  import { layerLabel } from "./lib/model";

  function shortcut(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    const key = e.key.toLowerCase();

    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      // V and M, as in every editor that has a move tool and a marquee.
      if (key === "v") setMode("layers");
      else if (key === "m") setMode("tiles");
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
</script>

<svelte:window onkeydown={shortcut} />

<main>
  <header>
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
    <button onclick={addImageToSelection} disabled={!app.selectedTiles.length || !!app.busy}>
      Bild auf Auswahl
    </button>
    <button
      onclick={() => assignSelection(true)}
      disabled={!canAssign(true)}
      title="Gewählte Kacheln zur gewählten Ebene hinzufügen"
    >
      + zur Ebene
    </button>
    <button
      onclick={() => assignSelection(false)}
      disabled={!canAssign(false)}
      title="Gewählte Kacheln aus der gewählten Ebene nehmen"
    >
      − von Ebene
    </button>
    <button
      onclick={restrictToSelection}
      disabled={!canRestrict()}
      title="Ebene nur noch auf den gewählten Kacheln"
    >
      nur Auswahl
    </button>
    <button onclick={undoEdit} disabled={!undoable()} title="Strg+Z">Rückgängig</button>
    <button onclick={redoEdit} disabled={!redoable()} title="Strg+Y">Wiederholen</button>
    <button onclick={saveToGame} disabled={!app.dir || !!app.busy}>Ins Spiel schreiben</button>
    <span class="status">
      {#if app.busy}
        {app.busy}…
      {:else if app.error}
        {app.error}
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
    <GridCanvas />

    <aside>
      <h2>Ebenen</h2>
      {#if !groups.length}
        <p class="empty">Keine Ebenen.</p>
      {/if}
      {#each groups as { overlay, layers } (overlay.id)}
        <!-- The assignment, not overlay.name: the name is fixed at creation, so
             an overlay made from every tile still called itself "Alle Kacheln"
             after one was taken away. Renaming arrives in M4. -->
        <h3 title={overlay.name}>
          {overlay.tiles === "all" ? "alle Kacheln" : `${overlay.tiles.length} Kacheln`}
        </h3>
        <ul>
          {#each layers as layer (layer.id)}
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
  .modes {
    display: flex;
    gap: 2px;
    margin-right: 6px;
    padding-right: 8px;
    border-right: 1px solid #232b31;
  }
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
  h3 {
    margin: 10px 0 3px;
    padding-bottom: 2px;
    border-bottom: 1px solid #232b31;
    color: #78dcff;
    font-size: 11px;
    font-weight: 500;
  }
  h3:first-of-type {
    margin-top: 0;
  }
  .eye {
    border-color: transparent;
    background: none;
  }
</style>
