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
    toggleOpen,
    toggleTileRow,
  } from "./lib/rows.svelte";
  import {
    app,
    dropTileLayer,
    fileTile,
    folders,
    looseIds,
    pickTileImage,
    alsoSelect,
    deleteLayer,
    renameLayer,
    selectLayer,
    toggleLayerHidden,
    toggleLayerLocked,
    toggleTile,
    setTileLayerField,
    tileHeadline,
    tileIcons,
    tileImageChoices,
    tileImages,
    tileLayers,
    tilePaintChoices,
    tileProject,
    tileShapes,
    unplace,
  } from "./lib/editor.svelte";
  import { ICON_NAMES, iconArt } from "./lib/icons";
  import { isGradient, layerLabel, type Layer } from "./lib/model";

  let {
    id,
    inGroup,
    openIcons,
    layerMenu,
  }: {
    id: string;
    inGroup: string;
    /** Asks App to open the class grid for this tile's badge. The sheet is
     *  App's — one of them serves the whole window — so the row asks rather
     *  than owns. */
    openIcons: (target: { tile: string; layer: string }) => void;
    /** Likewise for the right-click menu on a layer row: one menu serves the
     *  window, so the row hands over the pair and App builds the items. */
    layerMenu: (e: MouseEvent, layerId: string, tileId: string) => void;
  } = $props();

  /** A tile's rows as the list draws them: topmost first. Every layer gets a
   *  row now — the filter that hid a layout's live copies went with layouts. */
  const stampsOf = (layers: Layer[]) => [...layers].reverse();

  /* What the row is drawing, read once per render. These opened the snippet as
     {@const}; a component's markup has no such holder, and $derived is the
     same idea with a name. */
  /** The layer whose name is being typed, "" for none. Local to the row: two
   *  rows can never be renaming at once, because opening one blurs the other. */
  let renaming = $state("");

  /** Focus *and* select, the way the tile's own name field does it. Focus
   *  alone leaves the caret at the end of the existing name, so the first
   *  thing typed is appended to it — "rect01" became "rect01Nameplate". The
   *  point of double-clicking a name is to replace it. */
  const takeName = (el: HTMLInputElement) => {
    el.focus();
    el.select();
  };

  const own = $derived(stampsOf(tileLayers(id)));
  const owner = $derived(tileProject(id));
  const said = $derived(tileHeadline(id));
  const badge = $derived(tileIcons(id)[0]);


</script>

<!-- The "place this" button stood here. It handed the wall a tile and a layer
     and switched the mode on; with the mode gone, picking the layer is the
     whole of what it did, and the name beside it already does that. -->


<!-- The stamps on one holder — a group's stack or a single tile's own. Same
     row either way, so `drop` is the only thing that differs: which list the
     reorder writes back to. -->
{#snippet stampRows(
  rows: Layer[],
  drop: (moving: string, parentId: string | null, beforeId: string | null) => void,
  /* The group these rows are the children of, "" for the tile's own stack.
     Carried because a drop lands in the list the row it was aimed at lives in:
     without it every drop was written as `parentId: null` and a row dragged
     between two members of a group escaped to the top of the tile. */
  parentId: string | null,
  /* The colour of the group these rows sit in, "" at the top level. A member
     wears its group's rather than carrying one of its own: recolouring a group
     is then one write that cannot half-apply, and a layer taken out of the
     group loses the colour by leaving, which is what the colour meant. */
  inherited: string,
)}
  <ul class="indent">
    {#each rows as layer (layer.id)}
      {@const tint = layer.tint ?? inherited}
      <!-- A group's row takes a drop in its middle third: that is how a layer
           joins a group that already exists. `canHold` was hard-coded false, so
           the only way in was to dissolve the group and make it again — three
           actions, all right-click-only, one of them the button labelled
           "Delete". relocateLayer has always taken a parent and folded the
           group's displacement in and out on the way; nothing else was
           missing. -->
      <li
        class:tinted={!!tint}
        style={tint ? `--tint: ${tint}` : undefined}
        class:selected={app.selectedTile === id &&
          (app.selected === layer.id || app.alsoSelected.includes(layer.id))}
        aria-current={app.selectedTile === id &&
        (app.selected === layer.id || app.alsoSelected.includes(layer.id))
          ? "true"
          : undefined}
        class:drop-before={drag.on?.id === layer.id && drag.on.where === "before"}
        class:drop-after={drag.on?.id === layer.id && drag.on.where === "after"}
        class:drop-into={drag.on?.id === layer.id && drag.on.where === "into"}
        draggable="true"
        ondragstart={(e) => startDrag(e, layer.id)}
        ondragover={(e) => over(e, layer.id, layer.kind === "group")}
        ondragleave={() => drag.on?.id === layer.id && (drag.on = null)}
        ondragend={endDrag}
        oncontextmenu={(e) => layerMenu(e, layer.id, id)}
        ondrop={(e) => {
          e.preventDefault();
          const spot = drag.on;
          const moving = drag.id;
          endDrag();
          if (!spot || !moving) return;
          const to = landing(rows, spot.id, spot.where, parentId);
          drop(moving, to.parentId, to.beforeId);
        }}
      >
        <button
          class="eye"
          title={layer.hidden ? "Show" : "Hide"}
          onclick={() => toggleLayerHidden(layer.id, id)}
        >
          <RowIcon name="eye" on={!!layer.hidden} />
        </button>
        <button
          class="eye"
          class:on={layer.locked}
          title={layer.locked ? "Unlock" : "Lock"}
          onclick={() => toggleLayerLocked(layer.id, id)}
        >
          <RowIcon name="lock" on={!!layer.locked} />
        </button>
        <!-- A group folds away, the way a tile's own row does. Its members were
             always drawn, so a tile with three groups of four was a column of
             fifteen rows to scroll past to reach the next tile — and the point
             of a group is to be one thing. Uses the same open set as every
             other row in the sidebar; a layer id can never collide with a tile
             id. -->
        {#if layer.kind === "group" && layer.children.length}
          <button
            class="twisty"
            title={isOpen(layer.id) ? "Fold the group away" : "Show what is in the group"}
            onclick={() => toggleOpen(layer.id)}
          >
            {isOpen(layer.id) ? "▾" : "▸"}
          </button>
        {/if}
        <!-- Double-click to rename, the way the tile above it is renamed. The
             input replaces the button rather than sitting beside it, so the row
             keeps its width and nothing shifts under the pointer.

             `layerLabel`, not `layer.name`: an unnamed layer shows what the
             list calls it, which is the text somebody double-clicking means to
             change. renameLayer knows that fallback and refuses to write it
             back as a real name — see the note there. -->
        {#if renaming === layer.id}
          <input
            class="name"
            use:takeName
            value={layerLabel(layer)}
            onkeydown={(e) => renameKey(e, layerLabel(layer))}
            onblur={(e) => {
              renaming = "";
              void renameLayer(layer.id, e.currentTarget.value, id);
            }}
          />
        {:else}
          <button
            class="name"
            class:dimmed={layer.hidden}
            onclick={(e) =>
              e.ctrlKey || e.metaKey ? alsoSelect(layer.id, id) : selectLayer(layer.id, id)}
            ondblclick={() => (renaming = layer.id)}
            title="Select this layer · Ctrl adds one · double-click to rename"
          >
            {layerLabel(layer)}
          </button>
        {/if}
        <button title="Delete" onclick={() => deleteLayer(layer.id, id)}>×</button>
      </li>
      <!-- A group's members, indented under it. The same snippet again, so a
           child row has everything a loose one has — its own eye, its own lock,
           its own name to rename. `drop` is the parent's: reordering inside a
           group writes the tile's stack, and relocateLayer is what works out
           which list the row actually landed in. -->
      {#if layer.kind === "group" && layer.children.length && isOpen(layer.id)}
        {@render stampRows(stampsOf(layer.children), drop, layer.id, tint)}
      {/if}
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
             but as the second line, where the layer count already lives.

             A tile that has not been named keeps the id as its headline, so
             the row never loses the one thing that always identifies it. -->
        {said || id}
        <span class="usage">
          {#if said}{id} &middot;
          {/if}{own.length
            ? `${own.length} layer${own.length === 1 ? "" : "s"}`
            : owner
              ? "bare"
              : "unassigned"}
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
        (moving, parentId, beforeId) => void dropTileLayer(id, moving, parentId, beforeId),
        null,
        "",
      )}
      <!-- A wording field stood here, one per caption. It was a single-line
           input, so the one thing a caption most often needs — a second line —
           could not be typed into it; the panel's Text box is a textarea and
           can. Two fields for one value, and only one of them able to hold
           what the layer accepts, so the row keeps the pictures and icons and
           leaves the words to the panel. -->

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
        </div>
      {/each}
    {/if}
  </div>
