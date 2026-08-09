<script lang="ts">
  /* What the selected layer is made of. Only the fields that have no other way
     in: position, rotation and size are on the canvas handles, so they are not
     repeated here. A caption whose words cannot be typed is useless, which is
     why this exists at all rather than waiting for the full panel system. */
  import { TILE_H, TILE_W } from "./lib/bmp";
  import { gridSize } from "./lib/geometry";
  import {
    openLayout,
    resetCrop,
    setLayerField,
    visibleIds,
    type LayerField,
  } from "./lib/editor.svelte";
  import {
    isGradient,
    findLayer,
    layerLabel,
    maskChoices,
    type Corners,
    type Layer,
    type Paint,
    type ShapeLayer,
  } from "./lib/model";
  import { systemFonts } from "./lib/platform";
  import { textWidth } from "./lib/scene";

  /** What this machine has installed. Fetched once behind the module-level
   *  cache in platform.ts — this panel is rebuilt every time the selection
   *  moves, and the answer cannot change while the app is open. */
  let families = $state<string[]>([]);
  void systemFonts().then((f) => (families = f));

  /** A family name as a CSS value. Quoted, because most of them have spaces,
   *  and escaped, because a name is data and this ends up inside a style
   *  attribute. */
  const css = (name: string) => `"${name.replace(/["\\]/g, "\\$&")}"`;

  /** Some fields only mean something in a Layout — "editable in grid" is about what
   *  happens at stamp time, and a layer already on a tile is past that. */
  let { layer, inLayout = false }: { layer: Layer; inLayout?: boolean } = $props();

  const set = (key: LayerField, value: unknown) => void setLayerField(layer.id, key, value);

  /** The shapes this layer could be cut to. Empty outside a Layout, and empty
   *  in one that holds no shape but this — which is what hides the control
   *  rather than offering a list with nothing in it. */
  const masks = $derived(inLayout ? maskChoices(openLayout()?.layers ?? [], layer.id) : []);

  /** How many tiles the open wall holds — the span a grid-space layer's x and y
   *  are fractions of. A layer on a tile is measured against the tile. */
  const wallCount = () => visibleIds().length;

  /** The name of a mask that is set but no longer a legal choice — an "Editable
   *  in grid" toggle away, since a per-tile cutter may only cut a per-tile
   *  layer. Empty when the mask is fine or absent. */
  const stale = $derived.by(() => {
    if (!layer.maskId || masks.some((m) => m.id === layer.maskId)) return "";
    const held = findLayer(openLayout()?.layers ?? [], layer.maskId);
    return held ? layerLabel(held) : "";
  });

  /** A Paint is a colour or a gradient. The first swatch edits the colour a
   *  flat paint is and the start colour of a gradient, so it is the one thing
   *  both forms have. */
  const flat = (p: Paint) => (isGradient(p) ? p.from : p);

  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);

  /** Degrees folded into one turn. Typing -10 means 350, and a layer left at
   *  370 by some earlier gesture shows as 10 rather than pinning the slider at
   *  its end — where the next nudge would have spun it most of the way round.
   *  Exactly 360 stays 360: it is where the slider's own drag ends, and folding
   *  it to 0 snapped the knob back to the far left mid-gesture. */
  const turn = (deg: number) => (deg === 360 ? 360 : ((deg % 360) + 360) % 360);
</script>

<h2 class="spaced">Properties</h2>

{#if layer.kind === "text"}
  <!-- The placeholder is a real feature with nothing in the UI to announce it,
       so the field says so itself. In the Layout there is no tile to expand it
       against and it stays literal — which looked like a placeholder that does
       not work. -->
  <label class="field" title="{'{{id}}'} becomes each portrait's id when the layout is stamped">
    <span>Text</span>
    <textarea rows="2" value={layer.text} oninput={(e) => set("text", e.currentTarget.value)}
    ></textarea>
  </label>
  <label class="field">
    <span>Font</span>
    <!-- A select and not a datalist: a datalist's popup is a suggestion list
         the browser styles itself and ignores font-family on, so every entry
         came out in the same face. Here each option is drawn in the font it
         names, which is the whole question being asked. -->
    <!-- The closed control wears the chosen font as well, so the panel answers
         "which one is this" without being opened at all. -->
    <select
      style="font-family: {css(layer.font)}"
      value={layer.font}
      onchange={(e) => set("font", e.currentTarget.value)}
    >
      <!-- The layer's own font leads the list even when this machine has no
           such font, or merely touching the control would quietly restyle a
           Layout built somewhere else. -->
      {#if !families.includes(layer.font)}
        <option value={layer.font} style="font-family: {css(layer.font)}">{layer.font}</option>
      {/if}
      {#each families as family (family)}
        <option value={family} style="font-family: {css(family)}">{family}</option>
      {/each}
    </select>
  </label>
  <label
    class="field"
    title="Same setting as the list above — type a font this machine does not have"
  >
    <span>Custom</span>
    <!-- The way to a font this machine does not have. A Layout is portable and
         the list is not, so the name has to stay typable. Both controls write
         the same field, which the tooltip now says: side by side and
         pre-filled with the same value, the pair read as a contest. -->
    <input value={layer.font} onchange={(e) => set("font", e.currentTarget.value)} />
  </label>
  <!-- The width the words wrap at, in tile pixels and independent of the font:
       a small font fits many letters before the first break, a large one few.
       Empty until it is set, because a caption that has never been given one
       still hugs its words — and pinning that on the first drag would move
       every old layout. The ↺ hands it back. -->
  <label class="field" title="Where the words wrap. Drag the caption's side handles for the same thing">
    <span>Width</span>
    <input
      type="range"
      min="0.05"
      max="1"
      step="any"
      value={layer.w ?? textWidth(layer)}
      oninput={(e) => set("w", num(e))}
    />
    {@render amount("w", (layer.w ?? textWidth(layer)) * TILE_W, (n) => n / TILE_W, 30)}
    <button
      class="reset"
      title="Let the box hug its words again"
      disabled={layer.w === undefined}
      onclick={() => set("w", undefined)}
    >
      ↺
    </button>
  </label>
  <!-- And how tall. Lines past it are cut off — the box is what promises a
       caption cannot grow into whatever sits beneath it. Absent means it grows
       downwards with its lines, as every caption did before this. -->
  <label class="field" title="Lines past this are cut off. Empty means the box grows with them">
    <span>Height</span>
    <input
      type="range"
      min="0.03"
      max="1"
      step="any"
      value={layer.h ?? 0.15}
      oninput={(e) => set("h", num(e))}
    />
    {@render amount("h", (layer.h ?? 0.15) * TILE_H, (n) => n / TILE_H, 20)}
    <button
      class="reset"
      title="Let the box grow with its lines again"
      disabled={layer.h === undefined}
      onclick={() => set("h", undefined)}
    >
      ↺
    </button>
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
    {@render amount("size", layer.size * TILE_W, (n) => n / TILE_W, 1)}
  </label>
  {#if inLayout}
    <!-- A state, not an action: the rest of this panel's little buttons all do
         something the moment they are pressed, and this one only says how the
         layer is treated later. -->
    <label
      class="check"
      title="Makes this layer editable on the wall — a mask travels with it"
    >
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
    <!-- aria-pressed, because "on" is drawn the same way focus is: after
         tabbing to Italic it looked switched on, and nothing but the canvas
         could tell you otherwise. -->
    <button
      class="b"
      class:on={layer.bold}
      aria-pressed={!!layer.bold}
      title="Bold"
      onclick={() => set("bold", !layer.bold)}
    >
      B
    </button>
    <button
      class="i"
      class:on={layer.italic}
      aria-pressed={!!layer.italic}
      title="Italic"
      onclick={() => set("italic", !layer.italic)}
    >
      I
    </button>
    {#each ["left", "center", "right"] as const as a}
      {@const w = a === "center" ? [14, 8, 12, 6] : [14, 9, 13, 7]}
      <button
        class:on={(layer.align ?? "center") === a}
        aria-pressed={(layer.align ?? "center") === a}
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
  {@render paint("Color", "color", layer.color)}
  <label class="field">
    <!-- "Outline" on a caption, "Border" on a shape and a picture: a letter
         gets an outline, a box gets a border, and calling both the same thing
         would make the wider scale a shape uses look like a bug. -->
    <span>Outline</span>
    <input
      type="range"
      min="0"
      max="0.02"
      step="0.001"
      value={layer.strokeWidth}
      oninput={(e) => set("strokeWidth", num(e))}
    />
    {@render amount("strokeWidth", layer.strokeWidth * TILE_W, (n) => n / TILE_W, 0)}
    <input
      type="color"
      value={layer.strokeColor}
      oninput={(e) => set("strokeColor", e.currentTarget.value)}
    />
  </label>
  {@render shadowField()}
{:else if layer.kind === "shape"}
  {#if inLayout}
    <!-- On shapes too, although a shape has no per-tile content of its own:
         what varies is the thing cutting it. A gradient block cut by each
         character's class icon needs the block to travel with the icon — the
         rule says a per-tile cutter may only cut a per-tile layer, and until
         the checkbox existed here a shape could never say yes to it. -->
    <label
      class="check"
      title="Makes this layer travel to the tiles — so a per-tile mask can cut it"
    >
      <input
        type="checkbox"
        checked={layer.perTile}
        onchange={(e) => set("perTile", e.currentTarget.checked)}
      />
      Editable in grid
    </label>
  {/if}
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
    {@render amount("w", layer.w * TILE_W, (n) => n / TILE_W, 1)}
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
    <!-- Off the tile's height, not its width: `h` is a fraction of the tile's
         other side, and 624 here would read a square as oblong. -->
    {@render amount("h", layer.h * TILE_H, (n) => n / TILE_H, 1)}
  </label>
  {@render paint("Fill", "fill", layer.fill)}
  <!-- An icon is a colour cut to the artwork's outline, so a border would trace
       the rectangle behind it and then be cut away with everything else outside
       the icon. A row that cannot do anything is worse than no row. -->
  {#if layer.shape !== "icon"}
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
      {@render amount("borderWidth", layer.borderWidth * TILE_W, (n) => n / TILE_W, 0)}
      <input
        type="color"
        value={layer.borderColor}
        oninput={(e) => set("borderColor", e.currentTarget.value)}
      />
    </label>
  {/if}
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
      <!-- Per cent of the shape's short side, which is what the number means —
           it is not a length, and half is the most a rounded rect can express. -->
      {@render amount("cornerRadius", layer.cornerRadius * 100, (n) => n / 100, 0, 50, "%")}
    </label>
    <!-- Which corners the radius reaches. A tab, a speech bubble and a
         half-round bar are all the same rect with two of these off, so one
         radius and four switches covers them without four more sliders.

         Laid out as the corners themselves lie, under the slider that feeds
         them and flush with its right edge. A row of four had no relation to
         the shape it edits — which button was the bottom-left one could only
         be learnt from the tooltip — where a 2x2 block with its sides named
         needs no reading at all. -->
    <div class="field corners">
      <!-- Empty label slot: the indent then comes from the same rule that puts
           every slider where it is, rather than from a copy of its width. -->
      <span></span>
      <div class="quad">
        <span></span>
        <span class="cap">L</span>
        <span class="cap">R</span>
        <span class="cap">T</span>
        {@render cornerToggle(layer, "tl")}
        {@render cornerToggle(layer, "tr")}
        <span class="cap">B</span>
        {@render cornerToggle(layer, "bl")}
        {@render cornerToggle(layer, "br")}
      </div>
    </div>
  {/if}
  {#if layer.shape === "polygon"}
    <label class="field">
      <!-- "Sides", not "Corners": next to a rounded rectangle's Corners slider
           and a picture's, the same word for a count and for a radius made the
           polygon read as roundable. The model has called it `sides` all
           along. -->
      <span>Sides</span>
      <input
        type="range"
        min="3"
        max="12"
        step="1"
        value={layer.sides}
        oninput={(e) => set("sides", num(e))}
      />
      <!-- Three is a triangle and the floor; the ceiling is where more corners
           stop being visible and the shape is just a slow circle. One ceiling,
           not two: the box used to accept 64, which the slider then threw back
           to 12 on the next touch. -->
      {@render amount("sides", layer.sides, (n) => n, 3, 12, "")}
    </label>
  {/if}
  {@render shadowField()}
{:else if layer.kind === "image"}
  {#if inLayout}
    <label
      class="check"
      title="Makes this layer editable on the wall — a mask travels with it"
    >
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
    <!-- The way back out of a trim. Dragging the handles outwards does it too,
         edge by edge; this is the one press that gives the whole picture back. -->
    <button
      disabled={!layer.crop}
      title={layer.crop
        ? "Show the whole picture again"
        : "Nothing is cropped — drag the side handles to trim this picture"}
      onclick={() => void resetCrop(layer.id)}
    >
      Reset crop
    </button>
  </div>
  <!-- Colour grading, images only: text and shapes pick their colour directly,
       and a second dial that turns the same knob is not a feature. Stored in
       the -1..1 the renderer's filters take; shown as per cent, and the hue as
       the degrees it turns. -->
  {#each [
    { key: "brightness", label: "Brightness" },
    { key: "contrast", label: "Contrast" },
    { key: "saturation", label: "Saturation" },
  ] as const as f}
    <label class="field">
      <span>{f.label}</span>
      <input
        type="range"
        min="-1"
        max="1"
        step="0.01"
        value={layer[f.key] ?? 0}
        oninput={(e) => set(f.key, num(e))}
      />
      {@render amount(f.key, (layer[f.key] ?? 0) * 100, (n) => n / 100, -100, 100, "%")}
    </label>
  {/each}
  <label class="field">
    <span>Hue</span>
    <input
      type="range"
      min="-1"
      max="1"
      step="0.01"
      value={layer.hue ?? 0}
      oninput={(e) => set("hue", num(e))}
    />
    {@render amount("hue", (layer.hue ?? 0) * 180, (n) => n / 180, -180, 180, "°")}
  </label>
  <label class="field">
    <span>Blur</span>
    <input
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={layer.blur ?? 0}
      oninput={(e) => set("blur", num(e))}
    />
    {@render amount("blur", (layer.blur ?? 0) * 100, (n) => n / 100, 0, 100, "%")}
  </label>
  <!-- Same two controls a shape's border has, and the same units — a frame is
       a frame whether it goes round a rectangle or round a portrait. Drawn
       inside the edge, so it never changes the space the layer occupies. -->
  <label class="field">
    <span>Border</span>
    <input
      type="range"
      min="0"
      max="0.05"
      step="0.002"
      value={layer.borderWidth ?? 0}
      oninput={(e) => set("borderWidth", num(e))}
    />
    {@render amount("borderWidth", (layer.borderWidth ?? 0) * TILE_W, (n) => n / TILE_W, 0)}
    <input
      type="color"
      value={layer.borderColor ?? "#000000"}
      oninput={(e) => set("borderColor", e.currentTarget.value)}
    />
  </label>
  <label class="field">
    <span>Corners</span>
    <!-- Per cent of the picture's short side, and half is the most a rounded
         rectangle can express — past it there is no rectangle left. -->
    <input
      type="range"
      min="0"
      max="0.5"
      step="0.02"
      value={layer.cornerRadius ?? 0}
      oninput={(e) => set("cornerRadius", num(e))}
    />
    {@render amount("cornerRadius", (layer.cornerRadius ?? 0) * 100, (n) => n / 100, 0, 50, "%")}
  </label>
  {@render shadowField()}
{:else}
  <!-- Opacity is real on a group — it is multiplied into the children on the
       way down. Rotation is not: layoutObjects passes a group's shift, lock and
       fade to its members and nothing else, so the slider used to write an
       angle nobody drew. Saying "no properties of its own" three lines above
       two working sliders was the other half of the same lie. -->
  <p class="empty">A group carries its children — only the fade below is its own.</p>
{/if}

{#if inLayout && layer.kind !== "group"}
  <!-- Masking is a Layout matter: that is where shapes and pictures lie in one
       stack. A tile carries only stamps and the copies a Layout keeps live,
       and there is nothing there to cut with. -->
  <label
    class="field"
    title={masks.length || stale
      ? "Clips this layer to another one in this Layout"
      : "Add another layer to this Layout first — there is nothing to cut with"}
  >
    <span>Mask</span>
    <!-- Shown even with nothing to offer. A control that appears and vanishes
         with the document's contents reads as a bug, and this one did: the row
         only existed once a shape happened to be present, so the feature
         looked missing. -->
    <select
      value={layer.maskId ?? ""}
      disabled={!masks.length && !stale}
      onchange={(e) => set("maskId", e.currentTarget.value)}
    >
      <option value="">none</option>
      {#each masks as shape (shape.id)}
        <option value={shape.id}>{layerLabel(shape)}</option>
      {/each}
      <!-- A mask the list can no longer offer stays on the layer — switching
           "Editable in grid" is enough to make one — and the row used to go
           grey and read "none" while it was still set. That is a stored value
           with no way back to "none" and a lie on top. It says so instead. -->
      {#if stale}
        <option value={layer.maskId}>{stale} — no longer allowed</option>
      {/if}
    </select>
  </label>
  {#if layer.maskId}
    <label class="check" title="Keeps what falls outside the shape instead of inside it">
      <input
        type="checkbox"
        checked={layer.maskInvert}
        onchange={(e) => set("maskInvert", e.currentTarget.checked)}
      />
      Invert
    </label>
  {/if}
{/if}

<!-- Where the layer's centre sits, in pixels of the surface it lives on — the
     tile, or the whole wall for a grid-space picture. The centre and not a
     corner, because the centre is what the model stores and what rotation
     turns around: a corner would be a derived number that stops meaning
     anything once the layer is turned. Dragging existed; typing "exactly the
     middle" did not. -->
{#snippet axis(key: "x" | "y", span: number)}
  <label class="field">
    <span>{key.toUpperCase()}</span>
    <input
      class="num"
      type="number"
      step="1"
      value={Math.round(layer[key] * span)}
      onchange={(e) => {
        const px = num(e);
        e.currentTarget.value = String(Math.round(px));
        set(key, px / span);
      }}
    />
    <span class="unit">px</span>
  </label>
{/snippet}
{@render axis("x", layer.space === "grid" ? gridSize(wallCount()).w : TILE_W)}
{@render axis("y", layer.space === "grid" ? gridSize(wallCount()).h : TILE_H)}

<!-- Rotation is on the canvas handle too, but a handle cannot be told "exactly
     ninety" — and the number it left behind was nowhere to be read.
     Not for groups: the renderer flattens a group into a shift and never turns
     it, so the control would promise something no pixel follows. -->
{#if layer.kind !== "group"}
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
  <!-- Not the shared snippet: a turn wraps rather than clamps, so -10 is 350
       and 370 is 10, and there is nothing to hold it between. -->
  <input
    class="num"
    type="number"
    step="1"
    value={Math.round(turn(layer.rotation))}
    onchange={(e) => {
      // Same reason as the shared snippet: 370 over a layer already at 10 is
      // no change at all, and the box would keep showing 370.
      const deg = turn(num(e));
      e.currentTarget.value = String(Math.round(deg));
      set("rotation", deg);
    }}
  />
  <span class="unit">°</span>
</label>
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
  {@render amount("opacity", layer.opacity * 100, (n) => n / 100, 0, 100, "%")}
</label>

<!-- The typed twin of a swatch. The native picker has sliders and no text
     field, so a colour from a palette had to be matched by eye. Accepts
     #8f6bff, 8f6bff and the f0f shorthand; anything else springs back to the
     colour the layer already has, the same rule the number boxes follow. -->
{#snippet hex(value: string, store: (v: string) => void)}
  <input
    class="hex"
    value={value}
    onchange={(e) => {
      const raw = e.currentTarget.value.trim().replace(/^#/, "");
      const long =
        /^[0-9a-f]{6}$/i.test(raw)
          ? raw
          : /^[0-9a-f]{3}$/i.test(raw)
            ? [...raw].map((c) => c + c).join("")
            : "";
      if (long) store(`#${long.toLowerCase()}`);
      else e.currentTarget.value = value;
    }}
  />
{/snippet}

<!-- The typed twin of a slider.

     A slider is for finding a value, not for hitting one, and every one of
     these had a number behind it that could only be reached by dragging. The
     box shows what the thing actually is — pixels for a length, per cent for
     a proportion, degrees for a turn — while the model keeps its fraction of
     the tile, so a layout still survives a change of tile resolution.

     `onchange`, never `oninput`: typing "64" over "8" passes through "6", and
     the layer must not visit that size on the way.

     `max` is left off where the renderer has no ceiling of its own — a shape
     wider than the tile is a legitimate thing to want, and the slider already
     stretches to follow one. It is given where exceeding it draws nothing at
     all (a corner radius past half the short side) or means nothing (opacity
     past opaque). -->
{#snippet amount(
  key: LayerField,
  shown: number,
  /* Not `=> number`: a gradient's angle and reach are typed twins too, and what
     they store is the whole rebuilt Paint rather than the number in the box. */
  store: (n: number) => unknown,
  min: number,
  max?: number,
  /* What the box counts in. Seven identical boxes on one shape held pixels,
     per cent and degrees with nothing to tell them apart — the comment above
     promised the distinction, the markup never showed it. */
  unit = "px",
)}
  <input
    class="num"
    type="number"
    {min}
    {max}
    step="1"
    value={Math.round(shown)}
    onchange={(e) => {
      const held = Math.min(Math.max(num(e), min), max ?? Infinity);
      /* Written straight back into the box, not left to the rebuild. Typing
         past a ceiling that the layer already sits at stores the same value it
         had, setLayerField sees no change and nothing re-renders — so "500"
         stayed on screen over an opacity of 1. */
      e.currentTarget.value = String(Math.round(held));
      set(key, store(held));
    }}
  />
  <span class="unit">{unit}</span>
{/snippet}

<!-- The halo every kind can cast, offset zero — a glow when the colour is
     bright, a drop shadow's soft edge when it is dark. One snippet because it
     is the same three controls on text, shape and picture, and the fields live
     on the common layer type. -->
{#snippet shadowField()}
  <label class="field">
    <span>Shadow</span>
    <input
      type="range"
      min="0"
      max="0.1"
      step="0.002"
      value={layer.shadow ?? 0}
      oninput={(e) => set("shadow", num(e))}
    />
    {@render amount("shadow", (layer.shadow ?? 0) * TILE_W, (n) => n / TILE_W, 0)}
    <input
      type="color"
      value={layer.shadowColor ?? "#000000"}
      oninput={(e) => set("shadowColor", e.currentTarget.value)}
    />
  </label>
{/snippet}

<!-- A colour, or the fade between two.

     Both fields that carry a Paint are edited here, so a gradient works the
     same way on a caption as on a shape. The switch is a third swatch showing
     what it would make; pressing it back keeps the start colour, so a gradient
     tried and rejected does not also lose the colour it grew out of.

     Two stops, by the model's design (see model.ts): a stop list needs a drag
     rail of its own, and the second colour is where nearly all of the use is. -->
{#snippet paint(label: string, key: "color" | "fill", p: Paint)}
  <label class="field">
    <span>{label}</span>
    <input
      type="color"
      value={flat(p)}
      oninput={(e) =>
        set(key, isGradient(p) ? { ...p, from: e.currentTarget.value } : e.currentTarget.value)}
    />
    {@render hex(flat(p), (v) => set(key, isGradient(p) ? { ...p, from: v } : v))}
    {#if isGradient(p)}
      <input
        type="color"
        value={p.to}
        oninput={(e) => set(key, { ...p, to: e.currentTarget.value })}
      />
      {@render hex(p.to, (v) => set(key, { ...p, to: v }))}
    {/if}
    <!-- Inside the label, and safe there: a label hands its click on to its
         first control only when the click did not land on an interactive
         descendant, which a button is. -->
    <button
      class="ramp"
      class:on={isGradient(p)}
      title={isGradient(p) ? "Back to one colour" : "Fade into a second colour"}
      onclick={() => set(key, isGradient(p) ? p.from : { from: flat(p), to: "#000000", angle: 0 })}
      aria-label={isGradient(p) ? "Back to one colour" : "Fade into a second colour"}
    ></button>
  </label>
  {#if isGradient(p)}
    <!-- Shaped like the fields around it — name in the label column, control
         where the sliders start — so the checkbox lines up with them. -->
    <label class="field check" title="Out from the centre instead of across in one direction">
      <span>Radial</span>
      <input
        type="checkbox"
        checked={p.radial}
        onchange={(e) => set(key, { ...p, radial: e.currentTarget.checked })}
      />
    </label>
    {#if p.radial}
      <label class="field">
        <span>Reach</span>
        <!-- A multiplier on the reach the renderer picks by itself, which is
             half the box's long side — so 100% is that, and the number is a
             per cent because the thing has no length of its own. -->
        <input
          type="range"
          min="0.2"
          max="3"
          step="0.02"
          value={p.radius ?? 1}
          oninput={(e) => set(key, { ...p, radius: num(e) })}
        />
        {@render amount(key, (p.radius ?? 1) * 100, (n) => ({ ...p, radius: n / 100 }), 20, 300, "%")}
      </label>
    {:else}
      <label class="field">
        <span>Angle</span>
        <input
          type="range"
          min="0"
          max="360"
          step="any"
          value={turn(p.angle)}
          oninput={(e) => set(key, { ...p, angle: num(e) })}
        />
        <!-- Not the shared snippet, for the same reason rotation is not: a turn
             wraps where the others clamp. -->
        <input
          class="num"
          type="number"
          step="1"
          value={Math.round(turn(p.angle))}
          onchange={(e) => {
            const deg = turn(num(e));
            e.currentTarget.value = String(Math.round(deg));
            set(key, { ...p, angle: deg });
          }}
        />
        <span class="unit">°</span>
      </label>
    {/if}
    <label class="field" title="Slide toward a colour to give the other one more room">
      <span>Balance</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={p.mid ?? 0.5}
        oninput={(e) => set(key, { ...p, mid: num(e) })}
      />
      {@render amount(key, (p.mid ?? 0.5) * 100, (n) => ({ ...p, mid: n / 100 }), 0, 100, "%")}
    </label>
  {/if}
{/snippet}

<!-- One switch of the 2x2 block. Takes the shape as a parameter because the
     block sits inside a branch that narrowed `layer`, and a snippet is written
     out here where that narrowing does not reach. -->
{#snippet cornerToggle(shape: ShapeLayer, corner: keyof Corners)}
  {@const on = shape.corners ? shape.corners[corner] : true}
  <button
    class="quad-toggle"
    class:on
    title={`Round the ${{ tl: "top-left", tr: "top-right", bl: "bottom-left", br: "bottom-right" }[corner]} corner`}
    onclick={() =>
      set("corners", {
        ...{ tl: true, tr: true, bl: true, br: true },
        ...shape.corners,
        [corner]: !on,
      })}
  >
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <!-- The square drawn with one corner cut, turned to whichever one this
           button owns. -->
      <g transform={`rotate(${{ tl: 0, tr: 90, br: 180, bl: 270 }[corner]} 8 8)`}>
        <path
          d={on ? "M3 8a5 5 0 0 1 5-5h5v10H3z" : "M3 3h10v10H3z"}
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
        />
      </g>
    </svg>
  </button>
{/snippet}

<style>
  h2 {
    margin: 18px 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #8f88a8;
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
    color: #8f88a8;
    font-size: 11px;
  }
  .row {
    display: flex;
    gap: 3px;
    margin-bottom: 4px;
    /* Same column as the checkboxes above: every control in this panel starts
       where the sliders start, and a button row is no exception. */
    margin-left: 68px;
  }
  /* Lined up under the sliders: the empty label slot supplies the indent, so
     the block starts exactly where every control above it starts. */
  .corners {
    margin-bottom: 6px;
  }
  .quad {
    display: grid;
    grid-template-columns: repeat(3, auto);
    gap: 3px;
    align-items: center;
    justify-items: center;
  }
  .cap {
    color: #8f88a8;
    font-size: 10px;
    letter-spacing: 0.04em;
  }
  /* Same 32px target as every other icon button; .row does this for the ones
     that live in a row, and these do not. */
  .quad-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
  }
  input,
  textarea,
  select {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 4px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #0e0b16;
    color: inherit;
  }
  /* The margin is the browser's own, and only range inputs carry it: it left
     every slider ending 2px short of the selects and number fields beside
     them. One right edge down the whole panel. */
  input[type="range"] {
    padding: 0;
    margin: 0;
    accent-color: #a685ff;
  }
  /* Every slider's typed twin. Named for what it holds rather than for one
     unit — pixels, per cent, degrees and plain counts all sit in it. */
  .num {
    flex: none;
    width: 48px;
  }
  .hex {
    flex: none;
    width: 68px;
    font-family: ui-monospace, monospace;
  }
  /* Sits against its box rather than in it: a suffix inside the field would be
     text the user has to delete before typing. Fixed width so the boxes of a
     row still line up when one counts degrees and the next per cent. */
  .unit {
    flex: none;
    width: 10px;
    color: #8b84a3;
    font-size: 11px;
  }
  /* A checkbox is a fixed little square, not a field that grows — the shared
     `input` rule above would stretch it across the panel. */
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    color: #8f88a8;
    font-size: 11px;
  }
  /* Indented into the control column the sliders start in — the label column
     is 62px plus the 6px gap. Not the .field.check rows: those put their name
     in the label column and are already aligned by it. */
  .check:not(.field) {
    margin-left: 68px;
  }
  .check input {
    flex: none;
    width: 13px;
    height: 13px;
    padding: 0;
    /* The browser's own 3px/4px around a checkbox, which would push it out of
       the column every slider beside it starts in. */
    margin: 0;
    accent-color: #8f6bff;
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
  /* The gradient switch, sized and shaped like the swatches it sits beside
     because it is one: it shows the fade it would turn the paint into.
     `button.ramp` rather than `.ramp` so it outweighs the shared `button.on`
     background — pressed, this one keeps its ramp and only its edge lights. */
  button.ramp {
    flex: none;
    width: 32px;
    height: 32px;
    padding: 0;
    background: linear-gradient(90deg, #8f6bff, #ff5fa8);
  }
  button.ramp.on {
    border-color: #a685ff;
  }
  button {
    font: inherit;
    padding: 2px 8px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #1d1832;
    color: inherit;
    cursor: pointer;
  }
  button.on {
    border-color: #a685ff;
    background: #2a2244;
    color: #e3dbff;
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
  .empty {
    margin: 0;
    color: #6f688a;
  }
</style>
