<script lang="ts">
  /* One tile, everywhere a tile is listed. Loose on the wall or put away in a
     drawer, it is the same row with the same reach — sorting a portrait into a
     drawer used to strip it of its wording fields and its picture gallery,
     which made the drawer a place work went to die.

     A component rather than the snippet it was, because the row had grown into
     most of what App.svelte was: the wording fields, the picture gallery, the
     class grid, the stamps and their drag all live here. What it still shares
     with the other lists — which rows are open, what is being carried, how a
     row is styled — sits in lib/rows.svelte.ts and rows.css, which is what let
     it leave without a line of CSS being copied.

     `inGroup` is the drawer holding it, "" when it is loose. The only
     difference it makes is the way out: back to the pile, or off the wall. */
  import { tick } from "svelte";

  import RowIcon from "./RowIcon.svelte";
  import { assetUrl, portrait } from "./lib/portrait";
  import {
    drag,
    endDrag,
    isOpen,
    landing,
    over,
    renameKey,
    startDrag,
    toggleTileRow,
  } from "./lib/rows.svelte";
  import {
    app,
    clearTileFrame,
    dropTileLayer,
    fileTile,
    folders,
    looseIds,
    pickTileImage,
    deleteLayer,
    selectLayer,
    toggleLayerHidden,
    toggleLayerLocked,
    toggleTile,
    setTileLayerField,
    tileCaptions,
    tileFrame,
    tileHeadline,
    tileIcons,
    tileImageChoices,
    tileImages,
    tileLayers,
    tilePaint,
    tilePaintChoices,
    tileProject,
    tileShapes,
    tileText,
    unplace,
  } from "./lib/editor.svelte";
  import { ICON_NAMES, iconArt } from "./lib/icons";
  import { isGradient, layerLabel, layoutNeedsRestamp, type Layer } from "./lib/model";

  let {
    id,
    inGroup,
    framing = $bindable(),
    openIcons,
  }: {
    id: string;
    inGroup: string;
    framing: boolean;
    /** Asks App to open the class grid for this tile's badge. The sheet is
     *  App's — one of them serves the whole window — so the row asks rather
     *  than owns. */
    openIcons: (target: { tile: string; layer: string }) => void;
  } = $props();

  /** A holder's rows as the list draws them: topmost first, and without the
   *  live copies a Layout keeps there — the stamp row speaks for them. */
  /** A tile's rows as the list draws them: topmost first. Every layer gets a
   *  row now — the filter that hid a layout's live copies went with layouts. */
  const stampsOf = (layers: Layer[]) => [...layers].reverse();

  /* What the row is drawing, read once per render. These opened the snippet as
     {@const}; a component's markup has no such holder, and $derived is the
     same idea with a name. */
  const own = $derived(stampsOf(tileLayers(id)));
  const owner = $derived(tileProject(id));
  const said = $derived(tileHeadline(id));
  const badge = $derived(tileIcons(id)[0]);


  /** Enter walks the tile list: this row closes, the next one opens, and the
   *  cursor lands in its wording field. Shift+Enter goes back.
   *
   *  Naming a wall is the one job here that is forty-four of the same thing,
   *  and it was forty-four reaches for the mouse — the list is an accordion, so
   *  the next row has no field to jump into until something opens it. The row
   *  is left closed behind you, which is what keeps the next one on screen
   *  instead of a metre down the page.
   *
   *  Within the list the row is in: a drawer's tiles walk that drawer, loose
   *  ones walk the loose pile. Nothing wraps at the end — a second pass that
   *  starts itself would type over the first name. */
  async function stepName(e: KeyboardEvent, from: string, group: string) {
    e.preventDefault();
    (e.currentTarget as HTMLInputElement).blur();
    const list = group ? (folders().find((f) => f.id === group)?.tiles ?? []) : looseIds();
    const next = list[list.indexOf(from) + (e.shiftKey ? -1 : 1)];
    if (!next) return;
    toggleTileRow(next);
    await tick();
    const field = document.querySelector<HTMLInputElement>(`[data-tile="${next}"] .field input`);
    field?.focus();
    field?.select();
    // `nearest`, so a row already in view is not yanked to the top of the pane.
    field?.closest(".group")?.scrollIntoView({ block: "nearest" });
  }
</script>

<!-- Where a tile says "this one, here". The tool needs a tile and one of its
     live layers; both are on this row already, so the button hands it the pair
     and switches the mode on rather than asking for three clicks in two places.
     Beside it the way back: the layer as the Layout placed it. -->
{#snippet placeRow(tileId: string, layer: Layer)}
  {@const layerId = layer.id}
  {@const on =
    framing && app.selected === layerId && app.selectedTiles.length === 1 && app.selectedTiles[0] === tileId}
  {@const shows = !layer.hidden}
  <button
    class="swatch"
    class:on
    disabled={!shows}
    title={shows
      ? on
        ? "Placing this on the wall — drag its frame"
        : "Place this on this tile"
      : "Switched off on this tile — nothing to place"}
    onclick={() => {
      app.selectedTiles = [tileId];
      selectLayer(layerId, tileId);
      framing = true;
    }}
  >
    <RowIcon name="place" size={13} />
  </button>
  <button
    class="swatch"
    title="Put it back where the Layout placed it"
    disabled={!tileFrame(tileId, layerId)}
    onclick={() => void clearTileFrame(tileId, layerId)}>⤢</button
  >
{/snippet}



<!-- The stamps on one holder — a group's stack or a single tile's own. Same
     row either way, so `drop` is the only thing that differs: which list the
     reorder writes back to. -->
{#snippet stampRows(rows: Layer[], drop: (moving: string, beforeId: string | null) => void)}
  <ul class="indent">
    {#each rows as layer (layer.id)}
      <li
        class:selected={app.selected === layer.id && app.selectedTile === id}
        aria-current={app.selected === layer.id && app.selectedTile === id ? "true" : undefined}
        class:drop-before={drag.on?.id === layer.id && drag.on.where === "before"}
        class:drop-after={drag.on?.id === layer.id && drag.on.where === "after"}
        draggable="true"
        ondragstart={(e) => startDrag(e, layer.id)}
        ondragover={(e) => over(e, layer.id, false)}
        ondragleave={() => drag.on?.id === layer.id && (drag.on = null)}
        ondragend={endDrag}
        ondrop={(e) => {
          e.preventDefault();
          const spot = drag.on;
          const moving = drag.id;
          endDrag();
          if (!spot || !moving) return;
          drop(moving, landing(rows, spot.id, spot.where, null).beforeId);
        }}
      >
        <button
          class="eye"
          title={layer.hidden ? "Show" : "Hide"}
          onclick={() => toggleLayerHidden(layer.id)}
        >
          <RowIcon name="eye" on={!!layer.hidden} />
        </button>
        <button
          class="eye"
          class:on={layer.locked}
          title={layer.locked ? "Unlock" : "Lock"}
          onclick={() => toggleLayerLocked(layer.id)}
        >
          <RowIcon name="lock" on={!!layer.locked} />
        </button>
        <button
          class="name"
          class:dimmed={layer.hidden}
          onclick={() => selectLayer(layer.id, id)}
          title="Select this layer"
        >
          {layerLabel(layer)}
        </button>
        <button title="Delete" onclick={() => deleteLayer(layer.id)}>×</button>
      </li>
    {/each}
  </ul>
{/snippet}

<!-- One tile, everywhere a tile is listed. Loose on the wall or put away in a
     group, it is the same row with the same reach — sorting a portrait into a
     drawer used to strip it of its wording fields and its picture gallery,
     which made the drawer a place work went to die.

     `inGroup` is the drawer holding it, "" when it is loose. The only
     difference it makes is the way out: back to the pile, or off the wall. -->

  <div
    class="group"
    role="presentation"
    data-tile={id}
    onmouseenter={() => (app.hoverTile = id)}
    onmouseleave={() => app.hoverTile === id && (app.hoverTile = "")}
  >
    <div
      class="grouphead"
      class:selected={app.selectedTiles.includes(id)}
      aria-current={app.selectedTiles.includes(id) ? "true" : undefined}
    >
      <button class="twisty" onclick={() => toggleTileRow(id)}>
        {isOpen(id) ? "▾" : "▸"}
      </button>
      <!-- The face, not the number. "40000000005773694" identifies a file and
           nobody else; at sixty-eight portraits the list was a column of digits
           to be matched against the wall by counting. The game's own picture,
           deliberately, even where a mosaic is baked over the tile: this
           answers "who is this", and a slice of some wall-wide image answers it
           for nobody. -->
      <canvas class="thumb" width="31" height="40" use:portrait={{ id, ready: !!app.deps }}
      ></canvas>
      <!-- The class, beside the face. Both answer "who is this", and both used
           to be one expand away — so a wall being dressed was read by opening
           forty-four rows one at a time. Pressable, and it opens the same
           artwork grid the expanded row does: the picture is already the
           control everywhere else in this app, and a row that shows a class
           without letting you change it is a row you have to expand anyway. -->
      {#if badge}
        {@const showing = badge.icon}
        <button
          class="rowicon"
          title={showing ? `${showing} — pick another class` : "Pick a class"}
          onclick={() => {
            openIcons({ tile: id, layer: badge.id });
          }}
        >
          {#if showing && iconArt(showing)}
            {@const art = iconArt(showing)!}
            <svg viewBox="0 0 {art.w} {art.h}" aria-hidden="true">
              {#each art.paths as p, i (i)}
                <path d={p.d} fill="#ffffff" fill-opacity={p.opacity} fill-rule="evenodd" />
              {/each}
            </svg>
          {:else}
            +
          {/if}
        </button>
      {/if}
      <button
        class="name"
        onclick={(e) => toggleTile(id, { ctrl: e.ctrlKey, shift: e.shiftKey })}
        title="Picks this tile on the wall · Ctrl adds one, Shift takes the range"
      >
        <!-- What the tile says, not what it is called on disk.
             "40000000005773694" identifies a file and nobody else, and at
             forty-four portraits the list was a column of digits to be matched
             against the wall by counting. The number stays — it is what the
             folder is sorted by and the only way to line a row up with a file —
             but as the second line, where the layout count already lives.

             A tile that has not been named keeps the id as its headline, so
             the row never loses the one thing that always identifies it. -->
        {said || id}
        <span class="usage">
          {#if said}{id} &middot;
          {/if}{own.length ? `${own.length} layout(s)` : owner ? "no layout" : "unassigned"}
        </span>
      </button>
      {#if inGroup}
        <!-- Out of the drawer, back among the loose ones. It never left the
             wall, so this is the only way out a filed tile needs. -->
        <button title="Back to the loose pile" onclick={() => fileTile(id, "")}>↓</button>
      {:else if owner && app.openProjectId}
        <!-- Off the grid, not out of the project: the tile keeps
             every layer and only gives up its slot, and the tiles
             after it close the gap. -->
        <button title="Off the wall, onto the shelf" onclick={() => unplace(id)}
          >↩</button
        >
      {/if}
    </div>

    {#if isOpen(id)}
      {@render stampRows(
        own,
        (moving, beforeId) => void dropTileLayer(id, moving, beforeId),
      )}
      <!-- What this tile alone says and shows. In the row rather
           than in a panel below the list: with forty-four rows,
           editing the first one meant scrolling past all of them
           and back. Here the fields cannot be further away than
           the row they belong to. -->
      {#each tileCaptions(id) as caption (caption.id)}
        <label class="field indent">
          <span>{layerLabel(caption)}</span>
          <!-- The layer's own words, edited in place. There used to be a
               default underneath and an override on top of it, with a button
               to drop back to the default; the layer belongs to this tile
               now, so there is one value and nothing to fall back to. -->
          <input
            value={caption.text}
            oninput={(e) =>
              void setTileLayerField([id], caption.id, "text", e.currentTarget.value)}
            onkeydown={(e) => e.key === "Enter" && void stepName(e, id, inGroup)}
          />
          {@render placeRow(id, caption)}
        </label>
      {/each}

      {#each tileImages(id) as pic (pic.id)}
        <p class="sub">{layerLabel(pic)}</p>
        <!-- A gallery rather than a file dialog per tile: class
             logos repeat across a wall, so from the second tile
             on the picture is almost always one already
             imported. The dialog stays, as the "+" that feeds
             the gallery. -->
        <div class="gallery indent">
          {#each tileImageChoices(id, pic.id) as asset (asset)}
            <button
              class="swatch"
              class:on={pic.asset === asset}
              title="Use this picture"
              onclick={() => void setTileLayerField([id], pic.id, "asset", asset)}
            >
              {#await assetUrl(asset) then url}
                <img src={url} alt="" />
              {/await}
            </button>
          {/each}
          <button
            class="swatch"
            title="Pick a new picture…"
            onclick={() => void pickTileImage(id, pic.id)}
          >
            +
          </button>
          <!-- A circle with a slash: the sign for "none of them",
               which is a choice here and not the absence of one. -->
          <button
            class="swatch none"
            class:on={pic.asset === ""}
            title="Show no picture on this tile"
            onclick={() => void setTileLayerField([id], pic.id, "asset", "")}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <circle
                cx="9"
                cy="9"
                r="7"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
              />
              <line
                x1="4"
                y1="14"
                x2="14"
                y2="4"
                stroke="currentColor"
                stroke-width="1.6"
              />
            </svg>
          </button>
          <!-- Placing it, and the way back from a placing that went wrong. No
               numbers beside them: the frame on the wall is where placing is
               done, and a row of fields here would ask why moving has them and
               everything else does not. -->
          {@render placeRow(id, pic)}
        </div>
      {/each}

      <!-- Which class this portrait is. The same map as the pictures above and
           the same bargain — the Layout placed and coloured the icon once, the
           tile names the class — but the choices need no importing, so it is
           the artwork grid rather than a gallery of what happens to be in
           play. -->
      {#each tileIcons(id) as badge (badge.id)}
        {@const showing = badge.icon}
        <!-- "Class", not the layer's name. An icon layer is auto-named after
             the class it was made with — Witch01 — so the layer's name over a
             tile showing Ranger asserted a class the tile does not have, forty
             times down the list. Here the question is which class this
             portrait is. -->
        <p class="sub">Class</p>
        <div class="gallery indent">
          <button
            class="swatch art"
            title={showing ? `${showing} — pick another class` : "Pick a class"}
            onclick={() => {
              openIcons({ tile: id, layer: badge.id });
            }}
          >
            {#if showing && iconArt(showing)}
              {@const art = iconArt(showing)!}
              <svg viewBox="0 0 {art.w} {art.h}" aria-hidden="true">
                {#each art.paths as p, i (i)}
                  <path d={p.d} fill="#ffffff" fill-opacity={p.opacity} fill-rule="evenodd" />
                {/each}
              </svg>
            {:else}
              +
            {/if}
          </button>
          <button
            class="swatch none"
            class:on={showing === ""}
            title="Show no icon on this tile"
            onclick={() => void setTileLayerField([id], badge.id, "icon", "")}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" stroke-width="1.6" />
              <line x1="4" y1="14" x2="14" y2="4" stroke="currentColor" stroke-width="1.6" />
            </svg>
          </button>
          {@render placeRow(id, badge)}
        </div>
      {/each}

      <!-- The shapes a Layout keeps live. They carry no per-tile content, so
           they had no row at all — which left the block of a badge unreachable
           while the icon cutting it could be moved. What a tile owns here is
           the colour, and the row that carries it carries the way into the
           placing tool too. -->
      {#each tileShapes(id) as shape (shape.id)}
        <p class="sub">{layerLabel(shape)}</p>
        <div class="gallery indent">
          {#each tilePaintChoices(id, shape.id) as colour (colour)}
            <button
              class="swatch flat"
              class:on={!isGradient(shape.fill) && shape.fill === colour}
              style="background: {colour}"
              title={`Paint it ${colour}`}
              aria-label={colour}
              onclick={() => void setTileLayerField([id], shape.id, "fill", colour)}
            ></button>
          {/each}
          <!-- The browser's picker, as the "+" that feeds the row — the same
               place the picture gallery puts its file dialog. -->
          <label class="swatch pick" title="Pick another colour for this tile">
            +
            <input
              type="color"
              value={isGradient(shape.fill) ? "#ffffff" : shape.fill}
              oninput={(e) =>
                void setTileLayerField([id], shape.id, "fill", e.currentTarget.value)}
            />
          </label>
          {@render placeRow(id, shape)}
        </div>
      {/each}
    {/if}
  </div>
