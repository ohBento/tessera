<script lang="ts">
  /* The three marks a list row wears, in one component because they are one
     idea: a small monochrome glyph that answers a button.

     Drawn rather than typed as emoji. An emoji is rendered by the system font
     in its own colours, which fights every theme it lands in and changes shape
     between machines. These take currentColor and stay put.

     A component rather than snippets in App.svelte: the tile list, the layer
     list and the toolbar all press these, and a snippet cannot be shared
     across files — so as soon as any of those lists moves out, the snippet has
     to become this or be copied. */
  let {
    name,
    on = false,
    size,
  }: {
    name: "eye" | "lock" | "place";
    /** The second state: an eye that is *hidden*, a lock that is *locked*.
     *  Ignored by "place", which has only one. */
    on?: boolean;
    /** Only "place" is drawn at two sizes — 13 beside a layer, 17 in the rail. */
    size?: number;
  } = $props();
</script>

{#if name === "eye"}
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M1 7c1.8-2.7 3.8-4 6-4s4.2 1.3 6 4c-1.8 2.7-3.8 4-6 4s-4.2-1.3-6-4z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
    />
    {#if on}
      <line x1="2.5" y1="11.5" x2="11.5" y2="2.5" stroke="currentColor" stroke-width="1.2" />
    {:else}
      <circle cx="7" cy="7" r="1.9" fill="currentColor" />
    {/if}
  </svg>
{:else if name === "lock"}
  <!-- Three differences at once, because one was not enough to read at a
       glance: the shackle closes, the body fills, and the button takes the
       accent colour. The old icon changed only by whether a 1.6px leg reached
       the body, which at 14px is a hairline nobody can see. -->
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d={on ? "M5.4 7.4V5.4a2.6 2.6 0 0 1 5.2 0v2" : "M5.4 7.4V5a2.6 2.6 0 0 1 5.2 0v0.6"}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
    />
    <rect
      x="2.75"
      y="7.4"
      width="10.5"
      height="6.6"
      rx="1.4"
      fill={on ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width="1.5"
    />
  </svg>
{:else}
  <!-- A crop frame with a picture's diagonal inside it — the mark every editor
       uses for "which part of this shows". Shared by the tool in the rail and
       by the button beside each of a tile's own layers, because pressing
       either starts the same thing. -->
  <svg width={size ?? 17} height={size ?? 17} viewBox="0 0 17 17" aria-hidden="true">
    <path d="M4.5 1 V12.5 H16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    <path d="M1 4.5 H12.5 V16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    <path d="M6.5 10.5 L8.8 7.6 L10.4 9.4 L12 7.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" opacity="0.8" />
  </svg>
{/if}
