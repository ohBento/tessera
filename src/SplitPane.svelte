<script lang="ts">
  /* Ported from BDO Composer 2's SplitPane, with the divider position kept in
     pixels rather than a ratio — the left pane has a fixed min and max width,
     which a ratio cannot express across window sizes. */
  import { untrack, type Snippet } from "svelte";

  interface Props {
    left: Snippet;
    right?: Snippet;
    min?: number;
    max?: number;
    initial?: number;
    storageKey?: string;
  }
  const { left, right, min = 520, max = 1100, initial = 840, storageKey }: Props = $props();

  const MIN_RIGHT = 300;

  // Seeded once on purpose — from here on the divider owns the width.
  let width = $state(
    untrack(() => {
      const stored = storageKey ? Number(localStorage.getItem(storageKey)) : NaN;
      return Number.isFinite(stored) && stored > 0 ? stored : initial;
    }),
  );
  let container: HTMLDivElement | undefined = $state();
  let dragging = $state(false);

  const clamp = (px: number, total: number) =>
    Math.max(min, Math.min(px, max, Math.max(min, total - MIN_RIGHT)));

  function onMove(e: PointerEvent) {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    width = clamp(e.clientX - rect.left, rect.width);
  }

  function stop() {
    dragging = false;
    if (storageKey) localStorage.setItem(storageKey, String(Math.round(width)));
  }

  function onKey(e: KeyboardEvent) {
    if (!container) return;
    const step = e.key === "ArrowLeft" ? -24 : e.key === "ArrowRight" ? 24 : 0;
    if (!step) return;
    e.preventDefault();
    width = clamp(width + step, container.getBoundingClientRect().width);
    stop();
  }

  $effect(() => {
    if (!dragging) return;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
    };
  });
</script>

<div class="split" bind:this={container}>
  <div class="pane" style:flex-basis={right ? `${width}px` : "100%"} style:max-width={right ? null : `${max}px`}>
    {@render left()}
  </div>

  {#if right}
    <div
      class="divider"
      class:dragging
      role="slider"
      aria-orientation="vertical"
      aria-label="Resize"
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabindex="0"
      onpointerdown={(e) => { dragging = true; e.preventDefault(); }}
      onkeydown={onKey}
    ></div>
    <div class="pane grow">{@render right()}</div>
  {/if}
</div>
