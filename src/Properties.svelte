<script lang="ts">
  /* What the selected layer is made of. Only the fields that have no other way
     in: position, rotation and size are on the canvas handles, so they are not
     repeated here. A caption whose words cannot be typed is useless, which is
     why this exists at all rather than waiting for the full panel system. */
  import { TILE_W } from "./lib/bmp";
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

  /** Degrees folded into one turn. Typing -10 means 350, and a layer left at
   *  370 by some earlier gesture shows as 10 rather than pinning the slider at
   *  its end — where the next nudge would have spun it most of the way round. */
  const turn = (deg: number) => ((deg % 360) + 360) % 360;
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
    <span>Font size</span>
    <!-- The ceiling still follows the layer, and there is still no step. The
         canvas handle no longer scales a caption, but every layout built while
         it did carries whatever size that produced — a fixed ceiling would
         stamp those flat the first time the slider was touched. -->
    <input
      type="range"
      min="0.02"
      max={Math.max(0.4, layer.size)}
      step="any"
      value={layer.size}
      oninput={(e) => set("size", num(e))}
    />
    <!-- Pixels, because that is what a font size means to a person; the model
         keeps its fraction of the tile so a layout survives a change of tile
         resolution. On change rather than on input: typing "64" over "8"
         passes through "6", and the caption should not jump there and back. -->
    <input
      class="px"
      type="number"
      min="1"
      step="1"
      value={Math.round(layer.size * TILE_W)}
      onchange={(e) => set("size", Math.max(1, num(e)) / TILE_W)}
    />
  </label>
  {#if inLayout}
    <!-- A state, not an action: the rest of this panel's little buttons all do
         something the moment they are pressed, and this one only says how the
         layer is treated later. -->
    <label class="check" title="Makes this layer editable in the grid-view">
      <input
        type="checkbox"
        checked={layer.perTile}
        onchange={(e) => set("perTile", e.currentTarget.checked)}
      />
      Editable in grid
    </label>
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
  {#if inLayout}
    <label class="check" title="Makes this layer editable in the grid-view">
      <input
        type="checkbox"
        checked={layer.perTile}
        onchange={(e) => set("perTile", e.currentTarget.checked)}
      />
      Editable in grid
    </label>
  {/if}
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

<!-- Rotation is on the canvas handle too, but a handle cannot be told "exactly
     ninety" — and the number it left behind was nowhere to be read. -->
<label class="field">
  <span>Rotation</span>
  <input
    type="range"
    min="0"
    max="360"
    step="any"
    value={turn(layer.rotation)}
    oninput={(e) => set("rotation", num(e))}
  />
  <input
    class="px"
    type="number"
    step="1"
    value={Math.round(turn(layer.rotation))}
    onchange={(e) => set("rotation", turn(num(e)))}
  />
</label>

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
  .px {
    flex: none;
    width: 48px;
  }
  /* A checkbox is a fixed little square, not a field that grows — the shared
     `input` rule above would stretch it across the panel. */
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    color: #8b979f;
    font-size: 11px;
  }
  .check input {
    flex: none;
    width: 13px;
    height: 13px;
    padding: 0;
    accent-color: #4d8fbd;
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
</style>
