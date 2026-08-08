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

  /* The keyboard half of `role="menu"`. The roles were here from the start and
   * nothing honoured them: focus stayed wherever the right-click happened, so
   * a screen reader announced a menu that could not be entered and the arrow
   * keys did nothing. Either the roles go or this does. */
  const entries = () => [...(el?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];

  /** Where focus was when the menu opened, so closing hands it back instead of
   *  dropping it on the document body. */
  let cameFrom: HTMLElement | null = null;

  $effect(() => {
    if (!el) return;
    cameFrom = document.activeElement as HTMLElement | null;
    entries()[0]?.focus();
    return () => cameFrom?.focus?.();
  });

  /** Moves along the enabled items, wrapping at either end. Separators and
   *  disabled entries are simply not in the list. */
  function step(by: number) {
    const list = entries();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(at + by + list.length) % list.length].focus();
  }

  function navigate(e: KeyboardEvent) {
    if (e.key === "ArrowDown") step(1);
    else if (e.key === "ArrowUp") step(-1);
    else if (e.key === "Home") entries()[0]?.focus();
    else if (e.key === "End") entries().at(-1)?.focus();
    else return;
    e.preventDefault();
  }

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

  /* Escape belongs to the innermost open thing. In the bubble phase it did not:
   * App's own Escape closes the Layout document and listens on the same window,
   * so one press over a layer's menu shut the menu *and* the document and left
   * the user back on the wall. Capture phase and stopped, exactly as
   * LayoutCanvas does it for a cancelled drag — the outer listeners never see
   * the key while a menu is up. */
  $effect(() => {
    const shut = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onclose();
    };
    /* The wheel rides along for the mirror-image reason: the wall's canvas
     * stops every wheel event to drive its own zoom, so a menu opened over the
     * wall — the place it is opened most — never heard the scroll it is
     * supposed to close on. Capture runs before the canvas gets the chance. */
    const scrolled = () => onclose();
    addEventListener("keydown", shut, true);
    addEventListener("wheel", scrolled, true);
    return () => {
      removeEventListener("keydown", shut, true);
      removeEventListener("wheel", scrolled, true);
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
/>

<div
  class="menu"
  bind:this={el}
  style:left="{placed.left}px"
  style:top="{placed.top}px"
  role="menu"
  tabindex="-1"
  onkeydown={navigate}
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
    background: #1d1832;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.5);
    font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
    color: #d9d4e8;
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
    background: #2a2244;
  }
  button:disabled {
    /* The app's one disabled fade — App.svelte uses 0.45 for every other
       control, and a menu that greys out differently reads as a different
       kind of "off". */
    opacity: 0.45;
    cursor: default;
  }
  hr {
    margin: 3px 6px;
    border: 0;
    border-top: 1px solid #262045;
  }
</style>
