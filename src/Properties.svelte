<script lang="ts">
  /* What the selected layer is made of. Only the fields that have no other way
     in: position, rotation and size are on the canvas handles, so they are not
     repeated here. A caption whose words cannot be typed is useless, which is
     why this exists at all rather than waiting for the full panel system. */
  import { setLayerField, type LayerField } from "./lib/editor.svelte";
  import { isGradient, type Layer, type Paint } from "./lib/model";

  /** Some fields only mean something in a Layout — "pro Kachel" is about what
   *  happens at stamp time, and a layer already on a tile is past that. */
  let { layer, inLayout = false }: { layer: Layer; inLayout?: boolean } = $props();

  const set = (key: LayerField, value: unknown) => void setLayerField(layer.id, key, value);

  /** A Paint is a colour or a gradient; the picker only edits flat colours, so
   *  a gradient shows its start colour and editing it drops back to flat. */
  const flat = (p: Paint) => (isGradient(p) ? p.from : p);

  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
</script>

<h2 class="spaced">Properties</h2>

{#if layer.kind === "text"}
  <label class="field">
    <span>Text</span>
    <textarea rows="2" value={layer.text} oninput={(e) => set("text", e.currentTarget.value)}
    ></textarea>
  </label>
  <label class="field">
    <span>Font</span>
    <input value={layer.font} onchange={(e) => set("font", e.currentTarget.value)} />
  </label>
  <label class="field">
    <span>Size</span>
    <!-- The ceiling follows the layer, and there is no step. A canvas handle
         has no limits, so a caption scaled past the end of the track showed as
         pinned at the maximum and the next nudge — the gesture that means "a
         hair smaller" — shrank it by half. Rounding did the same in miniature:
         touching the slider at all snapped the size to the nearest step. -->
    <input
      type="range"
      min="0.02"
      max={Math.max(0.4, layer.size)}
      step="any"
      value={layer.size}
      oninput={(e) => set("size", num(e))}
    />
  </label>
  {#if inLayout}
    <div class="row">
      <button
        class:on={layer.perTile}
        onclick={() => set("perTile", !layer.perTile)}
        title="Kept out of the stamp — laid on every tile as a live layer, so each tile can carry its own wording"
      >
        {layer.perTile ? "✓ " : ""}per tile
      </button>
    </div>
    {#if layer.perTile}
      <p class="hint">
        Stays out of the stamp. Editable per tile once stamped; "{"{{id}}"}" becomes
        the tile id.
      </p>
    {/if}
  {/if}
  <!-- The glyphs every text editor uses: a bold B, an italic I, and alignment
       as little line stacks whose ragged side says which way the text falls. -->
  <div class="row">
    <button class="b" class:on={layer.bold} title="Bold" onclick={() => set("bold", !layer.bold)}>
      B
    </button>
    <button
      class="i"
      class:on={layer.italic}
      title="Italic"
      onclick={() => set("italic", !layer.italic)}
    >
      I
    </button>
    {#each ["left", "center", "right"] as const as a}
      {@const w = a === "center" ? [14, 8, 12, 6] : [14, 9, 13, 7]}
      <button
        class:on={(layer.align ?? "center") === a}
        title={a === "left" ? "Align left" : a === "right" ? "Align right" : "Center"}
        onclick={() => set("align", a)}
      >
        <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
          {#each w as lw, i}
            <rect
              x={a === "left" ? 1 : a === "right" ? 15 - lw : (16 - lw) / 2}
              y={1 + i * 3.4}
              width={lw}
              height="1.6"
              rx="0.8"
              fill="currentColor"
            />
          {/each}
        </svg>
      </button>
    {/each}
  </div>
  <label class="field">
    <span>Color</span>
    <input type="color" value={flat(layer.color)} oninput={(e) => set("color", e.currentTarget.value)} />
  </label>
  <label class="field">
    <span>Outline</span>
    <input
      type="range"
      min="0"
      max="0.02"
      step="0.001"
      value={layer.strokeWidth}
      oninput={(e) => set("strokeWidth", num(e))}
    />
    <input
      type="color"
      value={layer.strokeColor}
      oninput={(e) => set("strokeColor", e.currentTarget.value)}
    />
  </label>
  <label class="field">
    <span>Shadow</span>
    <input
      type="range"
      min="0"
      max="0.1"
      step="0.002"
      value={layer.shadow}
      oninput={(e) => set("shadow", num(e))}
    />
    <input
      type="color"
      value={layer.shadowColor}
      oninput={(e) => set("shadowColor", e.currentTarget.value)}
    />
  </label>
{:else if layer.kind === "shape"}
  <!-- Width and height are the one size the canvas handles cannot give you
       exactly, and a shape is the only kind that keeps them apart. -->
  <label class="field">
    <span>Width</span>
    <input
      type="range"
      min="0.02"
      max={Math.max(1.5, layer.w)}
      step="any"
      value={layer.w}
      oninput={(e) => set("w", num(e))}
    />
  </label>
  <label class="field">
    <span>Height</span>
    <input
      type="range"
      min="0.02"
      max={Math.max(1.5, layer.h)}
      step="any"
      value={layer.h}
      oninput={(e) => set("h", num(e))}
    />
  </label>
  <label class="field">
    <span>Fill</span>
    <input type="color" value={flat(layer.fill)} oninput={(e) => set("fill", e.currentTarget.value)} />
  </label>
  <label class="field">
    <span>Border</span>
    <input
      type="range"
      min="0"
      max="0.05"
      step="0.002"
      value={layer.borderWidth}
      oninput={(e) => set("borderWidth", num(e))}
    />
    <input
      type="color"
      value={layer.borderColor}
      oninput={(e) => set("borderColor", e.currentTarget.value)}
    />
  </label>
  {#if layer.shape === "rect"}
    <label class="field">
      <span>Corners</span>
      <!-- Half the short side is the maximum a rounded rect can express; past
           it Canvas draws nothing at all, so the slider stops there. -->
      <input
        type="range"
        min="0"
        max="0.5"
        step="0.02"
        value={layer.cornerRadius}
        oninput={(e) => set("cornerRadius", num(e))}
      />
    </label>
  {/if}
  {#if layer.shape === "polygon"}
    <label class="field">
      <span>Corners</span>
      <input
        type="range"
        min="3"
        max="12"
        step="1"
        value={layer.sides}
        oninput={(e) => set("sides", num(e))}
      />
      <span class="value">{layer.sides}</span>
    </label>
  {/if}
{:else if layer.kind === "image"}
  <!-- Mirrored triangles across a dashed axis — the flip icon every editor
       uses. The vertical one is the same drawing turned a quarter. -->
  <div class="row">
    {#each [
      { key: "flipX", title: "Flip horizontally", turn: 0 },
      { key: "flipY", title: "Flip vertically", turn: 90 },
    ] as const as f}
      <button class:on={layer[f.key]} title={f.title} onclick={() => set(f.key, !layer[f.key])}>
        <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
          <g transform="rotate({f.turn} 8 7)">
            <path d="M6 2.5 L6 11.5 L1.5 11.5 Z" fill="currentColor" />
            <path d="M10 2.5 L10 11.5 L14.5 11.5 Z" fill="none" stroke="currentColor" stroke-width="1.2" />
            <line x1="8" y1="0.5" x2="8" y2="13.5" stroke="currentColor" stroke-width="1" stroke-dasharray="2 1.6" />
          </g>
        </svg>
      </button>
    {/each}
  </div>
{:else}
  <p class="empty">A group has no properties of its own.</p>
{/if}

<label class="field">
  <span>Opacity</span>
  <input
    type="range"
    min="0"
    max="1"
    step="0.02"
    value={layer.opacity}
    oninput={(e) => set("opacity", num(e))}
  />
</label>

<style>
  h2 {
    margin: 18px 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #8b979f;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .field > span:first-child {
    flex: none;
    width: 62px;
    color: #8b979f;
    font-size: 11px;
  }
  .row {
    display: flex;
    gap: 3px;
    margin-bottom: 4px;
  }
  input,
  textarea {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 4px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #0d1114;
    color: inherit;
  }
  input[type="range"] {
    padding: 0;
  }
  /* Swatch and control heights match the toolbar's 32px, so a properties row
     and a tool button are the same target. */
  input[type="color"] {
    flex: none;
    width: 32px;
    height: 32px;
    padding: 0;
  }
  textarea {
    resize: vertical;
  }
  button {
    font: inherit;
    padding: 2px 8px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #1b2228;
    color: inherit;
    cursor: pointer;
  }
  button.on {
    border-color: #78dcff;
    background: #223039;
    color: #cdeeff;
  }
  .row button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    height: 32px;
    padding: 0 8px;
    font-size: 15px;
  }
  button.b {
    font-weight: 700;
  }
  button.i {
    font-style: italic;
    font-family: Georgia, "Times New Roman", serif;
  }
  .value {
    flex: none;
    width: 18px;
    color: #8b979f;
    font-size: 11px;
  }
  .empty {
    margin: 0;
    color: #6c777e;
  }
  .hint {
    margin: 0 0 6px;
    color: #6c777e;
    font-size: 11px;
  }
</style>
