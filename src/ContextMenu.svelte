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
    | { label: string; items: Item[]; disabled?: boolean }
    | { separator: true };

  const isSub = (i: Item): i is { label: string; items: Item[]; disabled?: boolean } =>
    "items" in i;

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
  /* This level's own buttons. `:scope >` and not a plain query, because an open
     submenu's buttons live inside this element too — nested rather than in a
     second menu of their own, so that a press inside one is a press inside
     `el` and the click-outside rule does not shut the parent under the hand. */
  const entries = () => [
    ...(el?.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)") ?? []),
  ];

  /** Which submenu is open, by index. One at a time — a menu two levels deep
   *  is already more than a right-click should need. */
  let openSub = $state(-1);
  let subEl: HTMLDivElement | undefined = $state();
  const subEntries = () => [
    ...(subEl?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
  ];

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

  /** The same, one level in. */
  function stepSub(by: number) {
    const list = subEntries();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(at + by + list.length) % list.length].focus();
  }

  const inSub = () => !!subEl?.contains(document.activeElement);

  function navigate(e: KeyboardEvent) {
    const deep = inSub();
    if (e.key === "ArrowDown") deep ? stepSub(1) : step(1);
    else if (e.key === "ArrowUp") deep ? stepSub(-1) : step(-1);
    else if (e.key === "Home") (deep ? subEntries() : entries())[0]?.focus();
    else if (e.key === "End") (deep ? subEntries() : entries()).at(-1)?.focus();
    /* Right opens the submenu the cursor is on and steps into it, left comes
       back out — what every menu on this platform does, and the only way in
       for anyone not using a mouse. */
    else if (e.key === "ArrowRight" && !deep) {
      const at = entries().indexOf(document.activeElement as HTMLButtonElement);
      const item = items[Number(entries()[at]?.dataset.at ?? -1)];
      if (!item || !isSub(item)) return;
      openSub = Number(entries()[at].dataset.at);
      queueMicrotask(() => subEntries()[0]?.focus());
    } else if (e.key === "ArrowLeft" && deep) {
      const back = openSub;
      openSub = -1;
      queueMicrotask(() =>
        entries()
          .find((b) => b.dataset.at === String(back))
          ?.focus(),
      );
    } else return;
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
      // Innermost first: one press shuts the submenu, the next shuts the menu.
      if (openSub >= 0) {
        const back = openSub;
        openSub = -1;
        queueMicrotask(() =>
          entries()
            .find((b) => b.dataset.at === String(back))
            ?.focus(),
        );
        return;
      }
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
    if ("separator" in item || isSub(item) || item.disabled) return;
    item.run();
    onclose();
  }

  /** Where the flyout sits: level with the row it belongs to, and to its left
   *  when there is no room on the right. Measured off the button rather than
   *  nested inside it, so the parent's own arrow keys keep working on a flat
   *  list of children. */
  let subTop = $state(0);
  let subLeft = $state(true);
  function openAt(i: number, button: HTMLButtonElement) {
    openSub = i;
    subTop = button.offsetTop;
    const room = innerWidth - (el?.getBoundingClientRect().right ?? 0);
    subLeft = room > 190;
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
    {:else if isSub(item)}
      <button
        role="menuitem"
        class="parent"
        aria-haspopup="menu"
        aria-expanded={openSub === i}
        data-at={i}
        disabled={item.disabled || !item.items.length}
        onclick={(e) => (openSub === i ? (openSub = -1) : openAt(i, e.currentTarget))}
        onmouseenter={(e) => !item.disabled && item.items.length && openAt(i, e.currentTarget)}
      >
        {item.label}<span class="arrow">▸</span>
      </button>
    {:else}
      <button
        role="menuitem"
        data-at={i}
        disabled={item.disabled}
        onclick={() => pick(item)}
        onmouseenter={() => (openSub = -1)}
      >
        {item.label}
      </button>
    {/if}
  {/each}
  {#if openSub >= 0}
    {@const open = items[openSub]}
    {#if isSub(open)}
      <!-- Inside this element on purpose: a press in here has to read as a
           press inside the menu, or the window listener above shuts the parent
           the moment you reach for a child. -->
      <div
        class="menu flyout"
        class:right={subLeft}
        style:top="{subTop}px"
        bind:this={subEl}
        role="menu"
        tabindex="-1"
      >
        {#each open.items as sub, j (j)}
          {#if "separator" in sub}
            <hr />
          {:else if isSub(sub)}
            <button role="menuitem" disabled>{sub.label}</button>
          {:else}
            <button role="menuitem" disabled={sub.disabled} onclick={() => pick(sub)}>
              {sub.label}
            </button>
          {/if}
        {/each}
      </div>
    {/if}
  {/if}
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
  /* The row that leads somewhere: its mark pushed to the far edge, so a column
     of them reads as a column. */
  button.parent {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .arrow {
    color: #8f88a8;
  }
  /* Level with its own row, and on whichever side has room. Six pixels of
     overlap rather than a gap: a pointer crossing a gap leaves the parent
     button, and the menu closed under the hand on the way over. */
  .flyout {
    position: absolute;
    max-height: 60vh;
    overflow-y: auto;
  }
  .flyout.right {
    left: calc(100% - 6px);
  }
  .flyout:not(.right) {
    right: calc(100% - 6px);
  }
</style>
