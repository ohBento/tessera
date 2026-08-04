<script lang="ts">
  /* M1 shell: deliberately bare. The panel system, the tool strip and the dense
   * token set land in M3 — this exists to exercise the canvas and the export
   * path end to end, plus the one thing the first real run proved unusable
   * without: seeing which layers exist. The old grid/editor/placer components
   * are still on disk, no longer reachable, and are deleted in M3. */
  import GridCanvas from "./GridCanvas.svelte";
  import {
    addGridImage,
    app,
    deleteLayer,
    layerRows,
    moveLayer,
    pickFolder,
    redoEdit,
    redoable,
    saveToGame,
    selectLayer,
    toggleLayerHidden,
    undoEdit,
    undoable,
  } from "./lib/editor.svelte";
  import { layerLabel } from "./lib/model";

  function shortcut(e: KeyboardEvent) {
    if (!e.ctrlKey || e.target instanceof HTMLInputElement) return;
    const key = e.key.toLowerCase();
    // Ctrl+Shift+Z as well as Ctrl+Y — both are in wide use and cost one clause.
    if (key === "z" && !e.shiftKey) void undoEdit();
    else if (key === "y" || (key === "z" && e.shiftKey)) void redoEdit();
    else return;
    e.preventDefault();
  }

  // Topmost first, matching what the canvas draws last.
  const listed = $derived([...layerRows()].reverse());
</script>

<svelte:window onkeydown={shortcut} />

<main>
  <header>
    <button onclick={pickFolder} disabled={!!app.busy}>Ordner öffnen</button>
    <button onclick={addGridImage} disabled={!app.dir || !!app.busy}>Bild über das Grid</button>
    <button onclick={undoEdit} disabled={!undoable()} title="Strg+Z">Rückgängig</button>
    <button onclick={redoEdit} disabled={!redoable()} title="Strg+Y">Wiederholen</button>
    <button onclick={saveToGame} disabled={!app.dir || !!app.busy}>Ins Spiel schreiben</button>
    <span class="status">
      {#if app.busy}
        {app.busy}…
      {:else if app.error}
        {app.error}
      {:else if app.dir}
        {app.manifest.order.length} Kacheln
      {/if}
    </span>
  </header>

  <div class="body">
    <GridCanvas />

    <aside>
      <h2>Ebenen</h2>
      {#if !listed.length}
        <p class="empty">Keine Ebenen.</p>
      {/if}
      <ul>
        {#each listed as { overlay, layer } (layer.id)}
          <li class:selected={app.selected === layer.id}>
            <button
              class="eye"
              title={layer.hidden ? "Einblenden" : "Ausblenden"}
              onclick={() => toggleLayerHidden(layer.id)}
            >
              {layer.hidden ? "○" : "●"}
            </button>
            <button
              class="name"
              class:dimmed={layer.hidden}
              title="{layerLabel(layer)} — {overlay.name}"
              onclick={() => selectLayer(layer.id)}
            >
              {layerLabel(layer)}
              <span class="overlay">{overlay.name}</span>
            </button>
            <button title="Nach oben" onclick={() => moveLayer(layer.id, true)}>↑</button>
            <button title="Nach unten" onclick={() => moveLayer(layer.id, false)}>↓</button>
            <button title="Löschen" onclick={() => deleteLayer(layer.id)}>×</button>
          </li>
        {/each}
      </ul>
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
  .overlay {
    display: block;
    overflow: hidden;
    color: #6c777e;
    font-size: 11px;
    text-overflow: ellipsis;
  }
  .eye {
    border-color: transparent;
    background: none;
  }
</style>
