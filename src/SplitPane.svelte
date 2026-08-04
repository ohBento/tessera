<script lang="ts">
  /* Ported from BDO Composer 2's SplitPane, with the divider position kept in
     pixels rather than a ratio — the left pane has a fixed min and max width,
     which a ratio cannot express across window sizes. */
  import { untrack, type Snippet } from "svelte";

  interface Props {
    left: Snippet;
    right?: Snippet;
    min?: number;
    /** The right pane's own content width — below this it just gets clipped. */
    minRight?: number;
    max?: number;
    initial?: number;
    storageKey?: string;
  }
  const {
    left,
    right,
    min = 420,
    minRight = 300,
    max = Infinity,
    initial = 840,
    storageKey,
  }: Props = $props();

  // Seeded once on purpose — from here on the divider owns the width.
  let width = $state(
    untrack(() => {
      const stored = storageKey ? Number(localStorage.getItem(storageKey)) : NaN;
      return Number.isFinite(stored) && stored > 0 ? stored : initial;
    }),
  );
  let container: HTMLDivElement | undefined = $state();
  let containerW = $state(0);
  let dragging = $state(false);

  /* When the window isn't wide enough for both minimums, minRight wins: the
     left pane (a scrollable grid) degrades gracefully at any width, but the
     right pane's fixed-width columns (editor stage + layers + panel) don't —
     below minRight they visibly overflow instead of just needing a scroll.
     Forcing the ceiling up to `min` even when total - minRight fell short of
     it (the previous behaviour) let the grid keep its full minimum while
     silently starving the editor below its own. */
  const clamp = (px: number, total: number) =>
    Math.max(0, Math.min(px, max, total - minRight));

  /* A width restored from a previous, wider window would push the right pane
     off screen, so re-clamp whenever the container resizes — including once at
     startup. Reads of `width` are untracked or this effect would retrigger
     itself. */
  $effect(() => {
    const total = containerW;
    if (!total) return;
    const current = untrack(() => width);
    const next = clamp(current, total);
    if (next !== current) width = next;
  });

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

<div class="split" bind:this={container} bind:clientWidth={containerW}>
  <div
    class="pane"
    style:flex-basis={right ? `${width}px` : "100%"}
    style:max-width={!right && Number.isFinite(max) ? `${max}px` : null}
  >
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
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      tabindex="0"
      onpointerdown={(e) => { dragging = true; e.preventDefault(); }}
      onkeydown={onKey}
    ></div>
    <div class="pane grow">{@render right()}</div>
  {/if}
</div>
