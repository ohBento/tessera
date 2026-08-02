<script lang="ts">
  import { t } from "./lib/i18n.svelte";
  import { COLS, defaultMosaicRect, gridAspect, gridRows } from "./lib/render";
  import { app, applyMosaic, visible } from "./lib/state.svelte";

  const STAGE_W = 720;
  const STAGE_H = 430;

  const p = $derived(app.placing!);
  const count = $derived(visible().length);
  const aspect = $derived(gridAspect(count));

  /* The grid frame is fixed; the picture moves under it. At 60 tiles the grid
     is 7 by 9, so the frame comes out tall and narrow, not wide. */
  const frame = $derived({
    w: Math.min(STAGE_W - 40, (STAGE_H - 20) * aspect),
    get h() {
      return this.w / aspect;
    },
  });
  const frameLeft = $derived((STAGE_W - frame.w) / 2);
  const frameTop = $derived((STAGE_H - frame.h) / 2);

  /** Screen pixels per source pixel: the framed rectangle fills the frame. */
  const scale = $derived(frame.w / p.rect.w);
  const cell = $derived({ w: frame.w / COLS, h: frame.h / gridRows(count) });

  let drag = $state<{ x: number; y: number; rx: number; ry: number } | null>(null);

  function onDown(e: PointerEvent) {
    drag = { x: e.clientX, y: e.clientY, rx: p.rect.x, ry: p.rect.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  /** Dragging moves the picture, so the framed rectangle travels the other way. */
  function onMove(e: PointerEvent) {
    if (!drag) return;
    p.rect.x = drag.rx - (e.clientX - drag.x) / scale;
    p.rect.y = drag.ry - (e.clientY - drag.y) / scale;
  }

  /** Zooms around the frame centre, so whatever is framed stays framed. */
  function zoomTo(w: number) {
    const next = Math.min(Math.max(w, p.w * 0.05), p.w * 4);
    const h = next / aspect;
    p.rect.x += (p.rect.w - next) / 2;
    p.rect.y += (p.rect.h - h) / 2;
    p.rect.w = next;
    p.rect.h = h;
  }

  /** Without preventDefault the wheel keeps scrolling the window underneath. */
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    zoomTo(p.rect.w * (e.deltaY > 0 ? 1.08 : 1 / 1.08));
  }

  const close = () => (app.placing = null);
  const fit = () => (app.placing!.rect = defaultMosaicRect(p.w, p.h, count));
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && close()} />

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
        oninput={(e) => zoomTo(+e.currentTarget.value)}
      />
    </label>
    <button onclick={fit}>{t("mosaic.fit")}</button>
    <button onclick={close}>{t("mosaic.cancel")}</button>
    <button onclick={applyMosaic}>{t("mosaic.apply")}</button>
  </div>

  <div
    class="stage"
    class:grabbing={!!drag}
    role="presentation"
    style="width:{STAGE_W}px; height:{STAGE_H}px"
    onwheel={onWheel}
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={() => (drag = null)}
  >
    <img
      src={p.url}
      alt=""
      draggable="false"
      style="width:{p.w * scale}px; height:{p.h * scale}px;
             left:{frameLeft - p.rect.x * scale}px; top:{frameTop - p.rect.y * scale}px"
    />
    <div
      class="frame"
      style="left:{frameLeft}px; top:{frameTop}px; width:{frame.w}px; height:{frame.h}px;
             background-size:{cell.w}px {cell.h}px"
    ></div>
  </div>
</div>
