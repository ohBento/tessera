<script lang="ts">
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { TILE_H, TILE_W } from "./lib/bmp";
  import {
    DEFAULT_IMAGE_SCALE,
    DEFAULT_TEXT_SIZE,
    isDetached,
    layerLabel,
    resetTransform,
    type TextLayer,
  } from "./lib/model";
  import { previewUrl } from "./lib/render";
  import { t } from "./lib/i18n.svelte";
  import {
    addImageLayer,
    addTextLayer,
    afterEdit,
    app,
    checkpointEdit,
    deleteLayer,
    detachLayer,
    editable,
    effective,
    moveLayer,
    reattachLayer,
    swapLayerImage,
    replaceTile,
    resetTile,
    setTileText,
    toggleHidden,
  } from "./lib/state.svelte";

  const EDITOR_W = 312;
  const EDITOR_H = Math.round((EDITOR_W * TILE_H) / TILE_W);
  const BLENDS = ["source-over", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "hard-light", "difference", "hue", "saturation", "color", "luminosity"];

  let url = $state("");
  const id = $derived(app.editing);
  const eff = $derived(effective(id));
  const layer = $derived(app.selectedLayer ? editable(id, app.selectedLayer) : undefined);
  const detached = $derived(!!layer && isDetached(app.manifest, id, layer.id));
  const shared = $derived(!!layer && app.manifest.shared.some((s) => s.id === layer.id));

  $effect(() => {
    const key = JSON.stringify(eff);
    let stale = false;
    previewUrl(app.dir, id, eff, EDITOR_W).then((next) => {
      if (stale) return URL.revokeObjectURL(next);
      URL.revokeObjectURL(url);
      url = next;
    });
    void key;
    return () => (stale = true);
  });

  let drag = $state<{ x: number; y: number; lx: number; ly: number } | null>(null);

  function onDown(e: PointerEvent) {
    if (!layer || layer.locked) return;
    checkpointEdit();
    drag = { x: e.clientX, y: e.clientY, lx: layer.x, ly: layer.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function onMove(e: PointerEvent) {
    if (!drag || !layer) return;
    layer.x = drag.lx + (e.clientX - drag.x) / EDITOR_W;
    layer.y = drag.ly + (e.clientY - drag.y) / EDITOR_H;
  }

  function onUp() {
    if (!drag || !layer) return;
    drag = null;
    afterEdit(id, layer.id);
  }

  const commit = () => layer && afterEdit(id, layer.id);

  function resetLayer() {
    if (!layer) return;
    checkpointEdit();
    resetTransform(layer);
    commit();
  }

  function toggleLock() {
    if (!layer) return;
    checkpointEdit();
    layer.locked = !layer.locked;
    commit();
  }

  function flip(axis: "flipX" | "flipY") {
    if (!layer || layer.kind !== "image") return;
    checkpointEdit();
    layer[axis] = !layer[axis];
    commit();
  }

  function resetSize() {
    if (!layer) return;
    checkpointEdit();
    if (layer.kind === "image") layer.scale = DEFAULT_IMAGE_SCALE;
    else layer.size = DEFAULT_TEXT_SIZE;
    commit();
  }

  function resetField(field: "rotation" | "opacity" | "strokeWidth" | "shadow", value: number) {
    if (!layer) return;
    checkpointEdit();
    if (field === "strokeWidth" || field === "shadow") {
      if (layer.kind !== "text") return;
      layer[field] = value;
    } else {
      layer[field] = value;
    }
    commit();
  }

  async function pickImageLayer(asShared: boolean) {
    const picked = await openDialog({
      filters: [{ name: t("image.pick"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg"] }],
    });
    if (typeof picked === "string") await addImageLayer(picked, asShared);
  }

  async function pickBase() {
    const picked = await openDialog({
      filters: [{ name: t("image.pick"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
    });
    if (typeof picked === "string") await replaceTile(id, picked);
  }

  async function swapImage() {
    if (!layer) return;
    const picked = await openDialog({
      filters: [{ name: t("image.pick"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg"] }],
    });
    if (typeof picked === "string") await swapLayerImage(id, layer.id, picked);
  }
</script>

{#snippet resetIcon()}
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M13.5 8A5.5 5.5 0 1 1 9.7 2.68a.75.75 0 1 1-.4 1.446A4 4 0 1 0 12 8a.75.75 0 0 1 1.5 0Z" />
    <path d="M9 1.75a.75.75 0 0 1 .75-.75H12.5a.75.75 0 0 1 .75.75V4.5a.75.75 0 0 1-1.5 0V3.56L10.28 5.03a.75.75 0 1 1-1.06-1.06L10.69 2.5H9.75A.75.75 0 0 1 9 1.75Z" />
  </svg>
{/snippet}

<div class="editor">
  <div class="stage">
    <img
      src={url}
      alt={id}
      width={EDITOR_W}
      height={EDITOR_H}
      draggable="false"
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerup={onUp}
      class:grabbing={!!drag}
    />
    <span class="pill">
      <span class="pill-label">{t("tile.file")}</span>
      <span class="numeric">{id}.bmp</span>
    </span>
  </div>

  <div class="panel">
    <div class="row">
      <button onclick={pickBase}>{t("tile.base")}</button>
      <button onclick={() => resetTile(id)}>{t("tile.reset")}</button>
      <button onclick={() => toggleHidden(id)}>
        {app.manifest.hidden.includes(id) ? t("tile.show") : t("tile.hide")}
      </button>
      <button onclick={() => (app.editing = "")}>{t("tile.closeEditor")}</button>
    </div>

    <div class="row">
      <button onclick={() => pickImageLayer(false)}>{t("layer.addImage")}</button>
      <button onclick={() => addTextLayer(false)}>{t("layer.addText")}</button>
    </div>
    <div class="row">
      <button onclick={() => pickImageLayer(true)}>{t("layer.addImageShared")}</button>
      <button onclick={() => addTextLayer(true)}>{t("layer.addTextShared")}</button>
    </div>

    <ul class="layers">
      <!-- Reversed so the top of the list is the top-most layer, as in every
           other editor — eff.layers is painted back to front. -->
      {#each [...eff.layers].reverse() as l (l.id)}
        <li class:sel={l.id === app.selectedLayer}>
          <button class="pick" onclick={() => (app.selectedLayer = l.id)}>{layerLabel(l)}</button>
          {#if app.manifest.shared.some((s) => s.id === l.id)}
            <span class="scope" class:local={isDetached(app.manifest, id, l.id)}>
              {isDetached(app.manifest, id, l.id) ? t("layer.scope.local") : t("layer.scope.all")}
            </span>
          {/if}
          <button class="step" onclick={() => moveLayer(id, l.id, -1)} title={t("layer.down")}>↓</button>
          <button class="step" onclick={() => moveLayer(id, l.id, 1)} title={t("layer.up")}>↑</button>
        </li>
      {/each}
    </ul>

    {#if layer}
      <div class="fields">
        <div class="row name-row">
          <label class="grow">{t("field.rename")}
            <input
              value={layer.name ?? ""}
              placeholder={layerLabel(layer)}
              onfocus={checkpointEdit}
              oninput={(e) => (layer.name = e.currentTarget.value)}
              onchange={commit}
            />
          </label>
          <button
            class="icon-toggle"
            class:on={!!layer.locked}
            onclick={toggleLock}
            aria-pressed={!!layer.locked}
            title={layer.locked ? t("layer.unlock") : t("layer.lock")}
          >
            {#if layer.locked}
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5A1.5 1.5 0 0 1 12.5 15h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm1.5 0h5V5a2.5 2.5 0 0 0-5 0v2Z" />
              </svg>
            {:else}
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path d="M11.5 7V5a2.5 2.5 0 0 0-4.975-.3.75.75 0 1 1-1.487-.2A4 4 0 0 1 13 5v2h-.5a1.5 1.5 0 0 1 2 1.5v5A1.5 1.5 0 0 1 12.5 15h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7h8Z" />
              </svg>
            {/if}
          </button>
          <button
            class="icon-toggle danger"
            onclick={() => deleteLayer(id, layer.id)}
            disabled={!!layer.locked}
            title={layer.locked ? t("layer.deleteLocked") : t("layer.delete")}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path d="M6 2h4a1 1 0 0 1 1 1v1h3v1.5H2V4h3V3a1 1 0 0 1 1-1Zm-1.5 4h7l-.6 8.1a1 1 0 0 1-1 .9H6.1a1 1 0 0 1-1-.9L4.5 6Z" />
            </svg>
          </button>
        </div>

        <div class="row">
          <button class:full={layer.kind !== "image"} onclick={resetLayer}>{t("layer.resetAll")}</button>
          {#if layer.kind === "image"}
            <button onclick={swapImage}>{t("layer.swapImage")}</button>
          {/if}
        </div>

        {#if layer.kind === "image"}
          <div class="row">
            <button class:on={!!layer.flipX} onclick={() => flip("flipX")}>{t("layer.flipX")}</button>
            <button class:on={!!layer.flipY} onclick={() => flip("flipY")}>{t("layer.flipY")}</button>
          </div>
        {/if}

        {#if shared}
          {#if detached}
            <button onclick={() => reattachLayer(id, layer.id)}>{t("layer.reattach")}</button>
          {:else}
            <button onclick={() => detachLayer(id, layer.id)}>{t("layer.detach")}</button>
          {/if}
        {/if}

        {#if layer.kind === "text"}
          <label>{t("field.text")}
            <input
              value={app.manifest.tiles[id]?.text[layer.id] ?? (layer as TextLayer).text}
              onfocus={checkpointEdit}
              oninput={(e) => setTileText(id, layer.id, e.currentTarget.value)}
              onchange={commit}
            />
          </label>
          <label>{t("field.font")}
            <select bind:value={layer.font} onchange={commit}>
              {#each app.fonts as font}<option value={font}>{font}</option>{/each}
            </select>
          </label>
          <label>{t("field.size")}
            <span class="slider">
              <input type="range" min="0.02" max="0.4" step="0.005" bind:value={layer.size} onchange={commit} />
              <button class="slider-reset" onclick={resetSize} title={t("field.resetOne")}>{@render resetIcon()}</button>
            </span>
          </label>
          <label>{t("field.color")}<input type="color" bind:value={layer.color} onchange={commit} /></label>
          <label>{t("field.strokeWidth")}
            <span class="slider">
              <input type="range" min="0" max="0.03" step="0.001" bind:value={layer.strokeWidth} onchange={commit} />
              <button class="slider-reset" onclick={() => resetField("strokeWidth", 0)} title={t("field.resetOne")}>{@render resetIcon()}</button>
            </span>
          </label>
          <label>{t("field.strokeColor")}<input type="color" bind:value={layer.strokeColor} onchange={commit} /></label>
          <label>{t("field.shadow")}
            <span class="slider">
              <input type="range" min="0" max="0.1" step="0.002" bind:value={layer.shadow} onchange={commit} />
              <button class="slider-reset" onclick={() => resetField("shadow", 0)} title={t("field.resetOne")}>{@render resetIcon()}</button>
            </span>
          </label>
          <label>{t("field.shadowColor")}<input type="color" bind:value={layer.shadowColor} onchange={commit} /></label>
        {:else}
          <label>{t("field.scale")}
            <span class="slider">
              <input type="range" min="0.02" max="2" step="0.01" bind:value={layer.scale} onchange={commit} />
              <button class="slider-reset" onclick={resetSize} title={t("field.resetOne")}>{@render resetIcon()}</button>
            </span>
          </label>
        {/if}

        <label>{t("field.rotation")}
          <span class="slider">
            <input type="range" min="-180" max="180" step="1" bind:value={layer.rotation} onchange={commit} />
            <button class="slider-reset" onclick={() => resetField("rotation", 0)} title={t("field.resetOne")}>{@render resetIcon()}</button>
          </span>
        </label>
        <label>{t("field.opacity")}
          <span class="slider">
            <input type="range" min="0" max="1" step="0.01" bind:value={layer.opacity} onchange={commit} />
            <button class="slider-reset" onclick={() => resetField("opacity", 1)} title={t("field.resetOne")}>{@render resetIcon()}</button>
          </span>
        </label>
        <label>{t("field.blend")}
          <select bind:value={layer.blend} onchange={commit}>
            {#each BLENDS as b}<option value={b}>{b}</option>{/each}
          </select>
        </label>
        <label>{t("field.filter")}
          <input placeholder="blur(2px) contrast(1.2)" bind:value={layer.filter} onchange={commit} />
        </label>

      </div>
    {/if}
  </div>
</div>
