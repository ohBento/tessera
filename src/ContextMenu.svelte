<script lang="ts">
  /* One menu, both documents. The wall opens it over tiles, the Layout editor
   * over layers, and the only thing that differs is the item list — so the
   * component knows nothing about either and takes what to show as data.
   *
   * Deliberately not a library: a menu is a positioned list that closes when
   * you click elsewhere, and the two rules that are easy to get wrong (stay on
   * screen, close on scroll) are three lines each. */

  export type Item =
    | { label: string; run: () => void; disabled?: boolean }
    | { separator: true };

  let {
    items,
    x,
    y,
    onclose,
  }: { items: Item[]; x: number; y: number; onclose: () => void } = $props();

  let el: HTMLDivElement | undefined = $state();

  /* Flipped rather than clamped when it would hang off the edge: a menu shoved
   * back inside covers the thing that was right-clicked. */
  const placed = $derived.by(() => {
    const w = el?.offsetWidth ?? 200;
    const h = el?.offsetHeight ?? 0;
    return {
      left: x + w > innerWidth ? Math.max(0, x - w) : x,
      top: y + h > innerHeight ? Math.max(0, y - h) : y,
    };
  });

  function pick(item: Item) {
    if ("separator" in item || item.disabled) return;
    item.run();
    onclose();
  }
</script>

<svelte:window
  onpointerdown={(e) => {
    if (el && !el.contains(e.target as Node)) onclose();
  }}
  onkeydown={(e) => e.key === "Escape" && onclose()}
  onwheel={onclose}
/>

<div
  class="menu"
  bind:this={el}
  style:left="{placed.left}px"
  style:top="{placed.top}px"
  role="menu"
  tabindex="-1"
>
  {#each items as item, i (i)}
    {#if "separator" in item}
      <hr />
    {:else}
      <button role="menuitem" disabled={item.disabled} onclick={() => pick(item)}>
        {item.label}
      </button>
    {/if}
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 20;
    min-width: 180px;
    padding: 3px;
    border: 1px solid #3a444c;
    border-radius: 4px;
    background: #1b2228;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.5);
    font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
    color: #cfd6dc;
  }
  button {
    display: block;
    width: 100%;
    padding: 4px 10px;
    border: 0;
    border-radius: 3px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: #223039;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  hr {
    margin: 3px 6px;
    border: 0;
    border-top: 1px solid #2a333a;
  }
</style>
