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

<h2 class="spaced">Eigenschaften</h2>

{#if layer.kind === "text"}
  <label class="field">
    <span>Text</span>
    <textarea rows="2" value={layer.text} oninput={(e) => set("text", e.currentTarget.value)}
    ></textarea>
  </label>
  <label class="field">
    <span>Schrift</span>
    <input value={layer.font} onchange={(e) => set("font", e.currentTarget.value)} />
  </label>
  <label class="field">
    <span>Größe</span>
    <input
      type="range"
      min="0.02"
      max="0.4"
      step="0.005"
      value={layer.size}
      oninput={(e) => set("size", num(e))}
    />
  </label>
  {#if inLayout}
    <div class="row">
      <button
        class:on={layer.perTile}
        onclick={() => set("perTile", !layer.perTile)}
        title="Nicht in den Stempel einbrennen — als lebende Ebene auf jede Kachel legen, damit jede ihren eigenen Wortlaut haben kann"
      >
        {layer.perTile ? "✓ " : ""}pro Kachel
      </button>
    </div>
    {#if layer.perTile}
      <p class="hint">
        Bleibt aus dem Stempel heraus. Nach dem Stempeln pro Kachel bearbeitbar; „{"{{id}}"}" wird
        die Kachel-ID.
      </p>
    {/if}
  {/if}
  <div class="row">
    <button class:on={layer.bold} onclick={() => set("bold", !layer.bold)}>F</button>
    <button class:on={layer.italic} onclick={() => set("italic", !layer.italic)}>K</button>
    {#each ["left", "center", "right"] as const as a}
      <button class:on={(layer.align ?? "center") === a} onclick={() => set("align", a)}>
        {a === "left" ? "⯇" : a === "right" ? "⯈" : "≡"}
      </button>
    {/each}
  </div>
  <label class="field">
    <span>Farbe</span>
    <input type="color" value={flat(layer.color)} oninput={(e) => set("color", e.currentTarget.value)} />
  </label>
  <label class="field">
    <span>Kontur</span>
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
    <span>Schatten</span>
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
    <span>Breite</span>
    <input
      type="range"
      min="0.02"
      max="1.5"
      step="0.01"
      value={layer.w}
      oninput={(e) => set("w", num(e))}
    />
  </label>
  <label class="field">
    <span>Höhe</span>
    <input
      type="range"
      min="0.02"
      max="1.5"
      step="0.01"
      value={layer.h}
      oninput={(e) => set("h", num(e))}
    />
  </label>
  <label class="field">
    <span>Füllung</span>
    <input type="color" value={flat(layer.fill)} oninput={(e) => set("fill", e.currentTarget.value)} />
  </label>
  <label class="field">
    <span>Rand</span>
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
      <span>Ecken</span>
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
      <span>Ecken</span>
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
  <div class="row">
    <button class:on={layer.flipX} onclick={() => set("flipX", !layer.flipX)}>↔ spiegeln</button>
    <button class:on={layer.flipY} onclick={() => set("flipY", !layer.flipY)}>↕ spiegeln</button>
  </div>
{:else}
  <p class="empty">Eine Gruppe hat keine eigenen Eigenschaften.</p>
{/if}

<label class="field">
  <span>Deckkraft</span>
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
    gap: 2px;
    margin-bottom: 4px;
  }
  input,
  textarea {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 2px 4px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #0d1114;
    color: inherit;
  }
  input[type="range"] {
    padding: 0;
  }
  input[type="color"] {
    flex: none;
    width: 26px;
    height: 20px;
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
