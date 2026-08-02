<script lang="ts">
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { languages, locale, setLocale, t } from "./lib/i18n.svelte";
  import {
    app,
    canRedo,
    canUndo,
    dirty,
    fillMosaic,
    open,
    redo,
    reorder,
    replaceTile,
    resetTile,
    restoreAll,
    saveToGame,
    undo,
  } from "./lib/state.svelte";

  let dragFrom = $state(-1);
  const dirtyIds = $derived(new Set(dirty()));

  const pickImage = () =>
    openDialog({
      filters: [{ name: t("image.pick"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
    });

  async function pickFolder() {
    const picked = await openDialog({ directory: true, defaultPath: app.dir || undefined });
    if (typeof picked === "string") await open(picked);
  }

  async function onReplace(id: string) {
    const picked = await pickImage();
    if (typeof picked === "string") await replaceTile(id, picked);
  }

  async function onMosaic() {
    const picked = await pickImage();
    if (typeof picked === "string") await fillMosaic(picked);
  }

  async function onRestoreAll() {
    if (confirm(t("vault.restore.confirm"))) await restoreAll();
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
  <button onclick={pickFolder}>{t("folder.choose")}</button>
  <span class="path">{app.dir}</span>
  <span>{t("tiles.count", { count: app.manifest.order.length })}</span>

  <button onclick={onMosaic} disabled={!app.manifest.order.length}>{t("mosaic.fill")}</button>
  <button onclick={undo} disabled={!canUndo()}>{t("edit.undo")}</button>
  <button onclick={redo} disabled={!canRedo()}>{t("edit.redo")}</button>

  <select value={locale.current} onchange={(e) => setLocale(e.currentTarget.value)}>
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

  {#if app.busy}<span class="dim">{t(`busy.${app.busy}`)}</span>{/if}
  {#if app.error}<span class="warn">{app.error}</span>{/if}
</div>

<div class="viewport">
  <div class="grid">
    {#each app.manifest.order as id, i (id)}
      <div
        class="cell"
        class:dirty={dirtyIds.has(id)}
        draggable="true"
        role="listitem"
        ondragstart={() => (dragFrom = i)}
        ondragover={(e) => e.preventDefault()}
        ondrop={() => reorder(dragFrom, i)}
      >
        <button class="tile" onclick={() => onReplace(id)} title={id}>
          <img src={app.preview[id]} alt={id} />
        </button>
        {#if app.manifest.tiles[id]}
          <button class="reset" onclick={() => resetTile(id)} title={t("tile.reset")}>×</button>
        {/if}
      </div>
    {/each}
  </div>
</div>
