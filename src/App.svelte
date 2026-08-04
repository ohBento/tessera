<script lang="ts">
  /* M1 shell: deliberately bare. The panel system, the tool strip and the dense
   * token set land in M3 — this exists to exercise the canvas and the export
   * path end to end, nothing more. The old grid/editor/placer components are
   * still on disk, no longer reachable, and are deleted in M3. */
  import GridCanvas from "./GridCanvas.svelte";
  import { addGridImage, app, pickFolder, saveToGame } from "./lib/editor.svelte";
</script>

<main>
  <header>
    <button onclick={pickFolder} disabled={!!app.busy}>Ordner öffnen</button>
    <button onclick={addGridImage} disabled={!app.dir || !!app.busy}>Bild über das Grid</button>
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

  <GridCanvas />
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
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid #232b31;
  }
  header button {
    font: inherit;
    padding: 4px 10px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #1b2228;
    color: inherit;
    cursor: pointer;
  }
  header button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .status {
    margin-left: auto;
    color: #8b979f;
  }
</style>
