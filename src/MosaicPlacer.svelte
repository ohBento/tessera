<script lang="ts">
  import { t } from "./lib/i18n.svelte";
  import { COLS, defaultMosaicRect, gridAspect, gridRows } from "./lib/render";
  import { app, applyMosaic, visible } from "./lib/state.svelte";

  const BOX_W = 640;
  const BOX_H = 420;

  const p = $derived(app.placing!);
  const count = $derived(visible().length);
  const aspect = $derived(gridAspect(count));
  /** Display scale only — the rectangle itself stays in source pixels. */
  const scale = $derived(Math.min(BOX_W / p.w, BOX_H / p.h));
  const cell = $derived({ w: (p.rect.w * scale) / COLS, h: (p.rect.h * scale) / gridRows(count) });

  let drag = $state<{ x: number; y: number; rx: number; ry: number } | null>(null);

  function onDown(e: PointerEvent) {
    drag = { x: e.clientX, y: e.clientY, rx: p.rect.x, ry: p.rect.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function onMove(e: PointerEvent) {
    if (!drag) return;
    p.rect.x = drag.rx + (e.clientX - drag.x) / scale;
    p.rect.y = drag.ry + (e.clientY - drag.y) / scale;
  }

  /** Zooms around the centre so the framed subject stays framed. */
  function setWidth(w: number) {
    const next = Math.min(Math.max(w, p.w * 0.05), p.w * 4);
    const h = next / aspect;
    p.rect.x += (p.rect.w - next) / 2;
    p.rect.y += (p.rect.h - h) / 2;
    p.rect.w = next;
    p.rect.h = h;
  }

  const onWheel = (e: WheelEvent) => setWidth(p.rect.w * (e.deltaY > 0 ? 1.08 : 1 / 1.08));
  const fit = () => (app.placing!.rect = defaultMosaicRect(p.w, p.h, count));
</script>

<div class="placer">
  <div class="bar">
    <span>{t("mosaic.place")}</span>
    <label class="zoom">{t("mosaic.zoom")}
      <input
        type="range"
        min={p.w * 0.05}
        max={p.w * 4}
        step={p.w / 400}
        value={p.rect.w}
        oninput={(e) => setWidth(+e.currentTarget.value)}
      />
    </label>
    <button onclick={fit}>{t("mosaic.fit")}</button>
    <button onclick={() => (app.placing = null)}>{t("mosaic.cancel")}</button>
    <button onclick={applyMosaic}>{t("mosaic.apply")}</button>
  </div>

  <div
    class="canvas"
    style="width:{Math.round(p.w * scale)}px; height:{Math.round(p.h * scale)}px"
    onwheel={onWheel}
  >
    <img src={p.url} alt="" draggable="false" width={Math.round(p.w * scale)} height={Math.round(p.h * scale)} />
    <div
      class="frame"
      class:grabbing={!!drag}
      role="presentation"
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerup={() => (drag = null)}
      style="left:{p.rect.x * scale}px; top:{p.rect.y * scale}px;
             width:{p.rect.w * scale}px; height:{p.rect.h * scale}px;
             background-size:{cell.w}px {cell.h}px"
    ></div>
  </div>
</div>
