<script lang="ts">
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { releasePage } from "./lib/update";
  import { COLS } from "./lib/render";
  import MosaicPlacer from "./MosaicPlacer.svelte";
  import SplitPane from "./SplitPane.svelte";
  import TileEditor from "./TileEditor.svelte";
  import { languages, locale, setLocale, t } from "./lib/i18n.svelte";
  import {
    app,
    dirty,
    ensurePreviewWidth,
    exportTo,
    loadSnapshot,
    open,
    redo,
    removeSnapshot,
    restoreAll,
    saveSnapshot,
    saveToGame,
    startMosaic,
    swapTiles,
    toggleHidden,
    toggleTileSelect,
    undo,
    visible,
  } from "./lib/state.svelte";

  let dragFrom = $state(-1);
  let gridWidth = $state(0);
  let chosen = $state("");
  const dirtyIds = $derived(new Set(dirty()));
  const shown = $derived(visible());

  // Keeps preview resolution in step with however wide the divider leaves the grid.
  $effect(() => {
    if (gridWidth > 0) ensurePreviewWidth(gridWidth / COLS);
  });

  async function pickFolder() {
    const picked = await openDialog({ directory: true, defaultPath: app.dir || undefined });
    if (typeof picked === "string") await open(picked);
  }

  async function onMosaic() {
    const picked = await openDialog({
      filters: [{ name: t("image.pick"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
    });
    if (typeof picked === "string") await startMosaic(picked);
  }

  async function onRestoreAll() {
    if (confirm(t("vault.restore.confirm"))) await restoreAll();
  }

  async function onExportTo() {
    const picked = await openDialog({ directory: true });
    if (typeof picked === "string") await exportTo(picked);
  }

  async function onSaveSnapshot() {
    const name = prompt(t("snapshot.name"))?.trim();
    if (name) await saveSnapshot(name);
  }

  async function onRemoveSnapshot() {
    if (chosen && confirm(t("snapshot.delete.confirm", { name: chosen }))) {
      await removeSnapshot(chosen);
      chosen = "";
    }
  }

  function onKey(e: KeyboardEvent) {
    if (!e.ctrlKey) return;
    if (e.key === "z") { e.preventDefault(); undo(); }
    if (e.key === "y") { e.preventDefault(); redo(); }
  }

  open();
</script>

<svelte:window onkeydown={onKey} />

<div class="bar">
  <button onclick={pickFolder} title={app.dir}>{t("folder.choose")}</button>

  {#if app.selectedTiles.length > 1}
    <span class="ok">{t("tiles.selected", { count: app.selectedTiles.length })}</span>
    <button onclick={() => (app.selectedTiles = [])}>{t("tiles.clearSelect")}</button>
  {/if}

  <button onclick={onMosaic} disabled={!shown.length}>{t("mosaic.fill")}</button>
  {#if app.manifest.mosaic}
    <button onclick={() => startMosaic()}>{t("mosaic.adjust")}</button>
  {/if}
  <span>{t("tiles.count", { count: shown.length })}</span>

  <select class="pin-right" value={locale.current} onchange={(e) => setLocale(e.currentTarget.value)}>
    {#each languages as lang}<option value={lang}>{lang.toUpperCase()}</option>{/each}
  </select>
</div>

<div class="bar">
  <span class={app.vaulted.length ? "ok" : "dim"}>
    {app.vaulted.length ? t("vault.safe") : t("vault.empty")}
  </span>
  <button onclick={onRestoreAll} disabled={!app.vaulted.length}>{t("vault.restore")}</button>

  <span class={dirtyIds.size ? "pending" : "dim"}>
    {dirtyIds.size ? t("save.dirty", { count: dirtyIds.size }) : t("save.clean")}
  </span>
  <button onclick={saveToGame} disabled={!dirtyIds.size}>{t("save.action")}</button>
  <button onclick={onExportTo}>{t("export.to")}</button>

  <span class="dim">{t("snapshot.title")}</span>
  <select class:ok={!!chosen} bind:value={chosen} onchange={() => chosen && loadSnapshot(chosen)}>
    <option value="">—</option>
    {#each app.snapshots as name}<option value={name}>{name}</option>{/each}
  </select>
  <button onclick={onSaveSnapshot}>{t("snapshot.save")}</button>
  <button onclick={onRemoveSnapshot} disabled={!chosen}>{t("snapshot.delete")}</button>

  {#if app.busy}<span class="dim">{t(`busy.${app.busy}`)}</span>{/if}
  {#if app.error}<span class="warn">{app.error}</span>{/if}
  {#if app.update}
    <span class="ok">{t("update.available", { version: app.update })}</span>
    <button onclick={() => openUrl(releasePage)}>{t("update.open")}</button>
  {/if}
</div>

{#if app.placing}
  <MosaicPlacer />
{/if}

{#snippet gridPane()}
  <div class="viewport">
    <div class="grid" bind:clientWidth={gridWidth}>
      {#each shown as id, i (id)}
        <div
          class="cell"
          class:editing={app.editing === id}
          class:multi={app.selectedTiles.includes(id)}
          draggable="true"
          role="listitem"
          ondragstart={() => (dragFrom = i)}
          ondragover={(e) => e.preventDefault()}
          ondrop={() => swapTiles(dragFrom, i)}
        >
          <button
            class="tile"
            onclick={(e) => (e.ctrlKey || e.metaKey ? toggleTileSelect(id) : (app.editing = id))}
            title={id}
          >
            <img src={app.preview[id]} alt={id} />
          </button>
        </div>
      {/each}
    </div>

    {#if app.manifest.hidden.length}
      <div class="hidden-strip">
        <span class="dim">{t("hidden.title", { count: app.manifest.hidden.length })}</span>
        {#each app.manifest.hidden as id (id)}
          <button class="chip" onclick={() => toggleHidden(id)} title={t("tile.show")}>{id.slice(-6)}</button>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet editorPane()}
  {#if app.editing}
    <TileEditor />
  {:else}
    <div class="editor">
      <div class="placeholder"></div>
      <p class="dim">{t("editor.empty")}</p>
    </div>
  {/if}
{/snippet}

<!-- The editor pane is always mounted: opening it on selection made the whole
     layout jump and squeezed the grid mid-click. -->
<SplitPane left={gridPane} right={editorPane} minRight={1260} storageKey="tessera.split" />
