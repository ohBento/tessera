<script lang="ts">
  /* Bare shell, still. Two documents live here — the wall and one open Layout —
   * and which is showing decides both the canvas in the middle and what the
   * side panel lists. The tool strip and dense token set land in M4; this
   * exists to drive the layout/stamp path end to end. */
  import { onMount, tick } from "svelte";
  import { getVersion, openUrl } from "./lib/platform";
  import { latestRelease, releasePage } from "./lib/update";

  import ContextMenu, { type Item } from "./ContextMenu.svelte";
  import RowIcon from "./RowIcon.svelte";
  import TileRow from "./TileRow.svelte";
  import GridCanvas from "./GridCanvas.svelte";
  import Properties from "./Properties.svelte";
  import {
    ARCHIVE,
    archived,
    bedChoices,
    bedFor,
    setBedTile,
    changedHere,
    archiveSelection,
    onArchive,
    addGridImage,
    addLayoutImage,
    addLayoutShape,
    addLayoutText,
    addTileImage,
    addTileShape,
    addTileText,
    app,
    assignLayoutToSelection,
    assignLayoutToWall,
    assignTileLayout,
    bakedCount,
    bakeMosaic,
    canAddGridImage,
    canBakeMosaic,
    canGroupLayers,
    canSaveToGame,
    canSaveLayout,
    clearMosaic,
    coverCounts,
    coverTheWall,
    clearTileAsset,
    clearTileFrame,
    clearTileText,
    clearTiles,
    closeLayoutDoc,
    deleteLayer,
    deleteLayoutLayer,
  deleteLayoutLayers,
    dropLayoutLayer,
    dropTileLayer,
    duplicateLayoutDoc,
    duplicateLayoutLayers,
    endGesture,
    fileSelectionInto,
    fileTile,
    folders,
    freeCount,
    groupLayoutLayers,
    inbox,
    keepAllCharacters,
    keepCharacter,
    layoutGroups,
    looseIds,
    layoutTiles,
    layouts,
    moveLayersIntoGroup,
    moveTilesToProject,
    newFolderHere,
    newLayoutDoc,
    newProjectFrom,
    nextSnapshotName,
    openFolder,
    openLayout,
    openLayoutDoc,
    openProject,
    openProjectView,
    placeTileAt,
    projects,
    redoEdit,
    historySteps,
    jumpEdit,
    redoLabel,
    redoable,
    releaseTilesToInbox,
    remainingFor,
    replaceCharacter,
    renameLayer,
    renameLayout,
    renameFolder,
    renameProject,
    restorableCount,
    removeFolder,
    renameSnapshot,
    saveLayout,
    selectLayer,
    selectLayoutLayer,
    strippableCount,
    setTileText,
    pickTileImage,
    setLayerField,
    setTileAsset,
    tileAsset,
    tileCaptions,
    tileHeadline,
    tileImageChoices,
    tileFrame,
    tileIcons,
    tileImages,
    tileLayers,
    tilePaint,
    tilePaintChoices,
    tileShapes,
    setTilePaint,
    clearTilePaint,
    shelfIds,
    snapshots,
    takeSnapshot,
    tileProject,
    unplace,
    tileText,
    visibleIds,
    wearing,
    removeLayoutFrom,
    toggleLayerHidden,
    toggleLayerLocked,
    toggleLayoutLayerHidden,
    toggleLayoutPick,
    toggleTile,
    undoEdit,
    undoLabel,
    undoable,
  } from "./lib/editor.svelte";
  import {
    allNewCharacters,
    clearLayers,
    confirmed,
    dropSnapshot,
    putBack,
    removeLayout,
    removeProject,
    resetProject,
    writeToGame,
  } from "./lib/ops";
  import {
    drag,
    endDrag,
    isOpen,
    landing,
    over,
    renameKey,
    reveal,
    rows,
    selectAll,
    startDrag,
    toggleOpen,
    toggleTileRow,
    zone,
    type Where,
  } from "./lib/rows.svelte";
  import { isTyping } from "./lib/geometry";
  import { ICON_NAMES, iconArt } from "./lib/icons";
  import { savePending } from "./lib/project";
  import {
    findLayer,
    isGradient,
    layerLabel,
    layoutNeedsRestamp,
    type Layer,
    type ShapeKind,
  } from "./lib/model";
  import { isLiveCopy, layerShows, offLayouts } from "./lib/stamps";

  const editing = $derived(openLayout());

  /* The FaceTexture folder is the only one this tool ever edits, so asking
     which one on every start was a dialog with one right answer. */
  onMount(() => void openFolder());

  function shortcut(e: KeyboardEvent) {
    if (isTyping(e.target)) return;
    const key = e.key.toLowerCase();

    /* The sheet answers to the key it documents, and closes on Escape like
       everything else that opens over the page. Checked before the Layout's own
       Escape, or opening it inside an editor would shut the document instead. */
    if (keysOpen && key === "escape") {
      keysOpen = false;
      e.preventDefault();
      return;
    }
    if (iconsOpen && key === "escape") {
      closeIconSheet();
      e.preventDefault();
      return;
    }
    /* Not under the icon grid. Both sheets sit at the same z-index and the grid
       is later in the markup, so it wins — the sheet opened out of sight and
       the key looked broken. Escape closes the grid, then `?` works. */
    if ((key === "?" || (key === "/" && e.shiftKey)) && !iconsOpen) {
      keysOpen = !keysOpen;
      e.preventDefault();
      return;
    }
    if (key === "escape" && framing) {
      framing = false;
      e.preventDefault();
      return;
    }
    if (key === "escape" && editing && !e.ctrlKey) {
      closeLayoutDoc();
      e.preventDefault();
      return;
    }
    /* Delete, and only inside a Layout. The same key on the wall would take a
       stamp off a portrait with one press, and a stamp is the work of a whole
       design rather than one layer. Typing is already excluded above, so a
       caption being edited keeps its own Delete. */
    if (
      (key === "delete" || key === "backspace") &&
      editing &&
      app.layoutSelection.length &&
      // Not while a sheet is up: the layer underneath is not what is being
      // looked at, and Escape is the key that sheet answers to.
      !keysOpen &&
      !iconsOpen
    ) {
      void deleteLayoutLayers([...app.layoutSelection]);
      e.preventDefault();
      return;
    }
    if (!e.ctrlKey) return;
    // Ctrl+Shift+Z as well as Ctrl+Y — both are in wide use and cost one clause.
    if (key === "z" && !e.shiftKey) void undoEdit();
    else if (key === "y" || (key === "z" && e.shiftKey)) void redoEdit();
    // The repeat gesture, so it earns a shortcut. Only inside a Layout: the
    // wall has no layers of its own to copy.
    else if (key === "d" && editing) void duplicateLayoutLayers();
    else return;
    e.preventDefault();
  }

  /** What this build is, and what is out there.
   *
   *  Asked once, at startup, and never again: a desktop tool that is open all
   *  day has no business polling. `latestRelease` answers "" for up to date, no
   *  release yet, and no network alike, so the quiet case needs no handling —
   *  and the noisy one is a dot, not a dialogue. One request to GitHub's public
   *  API per start, which is the only call this app makes to the internet. */
  let version = $state("");
  let newer = $state("");
  onMount(async () => {
    version = await getVersion();
    newer = await latestRelease();
  });

  /** Why the link did not open, "" while nothing has gone wrong.
   *
   *  Beside the link rather than in the status line, because the sheet covers
   *  that line — a message the press itself hides is no better than none. */
  let linkFailed = $state("");

  /** Opens the release page, and says so when it cannot.
   *
   *  It was `void openUrl(...)`, which turned a rejection into an unhandled
   *  promise nobody sees: the capability granted the command but put no URL in
   *  its scope, so the plugin answered ForbiddenUrl and pressing the link did
   *  nothing at all, for two releases. The scope is fixed and pinned by a test;
   *  this is the half that makes the next such failure say something. */
  async function openRelease() {
    linkFailed = "";
    try {
      await openUrl(releasePage);
    } catch (e) {
      linkFailed = `Could not open the browser — ${releasePage} (${e})`;
    }
  }

  /** Whether the keyboard sheet is up.
   *
   *  Every one of these is discoverable only by being told: a drag that swaps
   *  rather than inserts, a modifier that switches snapping off, a duplicate
   *  bound to Ctrl+D. Undo and Redo carry theirs in a tooltip, but a gesture
   *  has no button to hang one on. */
  let keysOpen = $state(false);
  let iconsOpen = $state(false);
  let iconFilter = $state("");
  /* The wall's one mode: while it is on, a drag frames a tile's picture inside
     its mask instead of sweeping a selection. Pressed-looking on purpose — a
     mode nobody can see is a trap. */
  let framing = $state(false);
  const closeIconSheet = () => {
    iconsOpen = false;
    iconTarget = null;
    iconFilter = "";
  };
  /* What the grid is answering, in the words of the thing that asked. */
  const iconHeading = () =>
    !iconTarget ? "Class icon" : iconTarget.tile ? "Class for this tile" : "Class for this layer";
  /* The class already in force, so the grid can mark it: the tile's own where a
     tile asked, otherwise the layer's. */
  const iconInForce = () => {
    if (!iconTarget) return undefined;
    const layer = findLayer(openLayout()?.layers ?? [], iconTarget.layer);
    const own = layer?.kind === "shape" ? layer.icon : undefined;
    return iconTarget.tile ? (tileAsset(iconTarget.tile, iconTarget.layer) ?? own) : own;
  };
  /* Who the icon grid is answering for: a tile naming its class, a Layout
     layer changing the class it is, or nobody — in which case picking one
     inserts a new layer. */
  let iconTarget = $state<{ tile?: string; layer: string } | null>(null);

  /* How a tile row reaches the class grid. One sheet serves the window, so the
     rows ask for it rather than each keeping their own. */
  const openIcons = (target: { tile: string; layer: string }) => {
    iconTarget = target;
    iconsOpen = true;
  };

  /** What the sheet lists. Written out rather than derived from the handler:
   *  half of these are canvas gestures that no handler declares, and a list
   *  that could drift is still better than a list nobody can find. */
  const KEYS: Array<[string, string]> = [
    ["Ctrl + Z", "Undo"],
    ["Ctrl + Y  ·  Ctrl + Shift + Z", "Redo"],
    ["Ctrl + D", "Duplicate the picked layers (in a Layout)"],
    ["Delete  ·  Backspace", "Delete the picked layers (in a Layout)"],
    ["Escape", "Leave the placing tool"],
    ["Escape", "Close the Layout, or the menu over it"],
    ["?", "This sheet"],
    ["Wheel", "Zoom"],
    ["Middle-drag", "Pan"],
    ["Space + drag", "Pan as well"],
    ["Drag", "Draw a selection box over tiles"],
    ["Ctrl + click", "Add one tile, or one layer, to the selection"],
    ["Shift + click", "Take the whole range up to it"],
    ["Alt + drag", "Swap two tiles instead of selecting"],
    ["Alt", "Held while dragging a handle: no snapping"],
    ["Double-click", "Rename a row · open a Layout from its stamp"],
    ["Enter  ·  Escape", "While renaming: keep the new name · put the old one back"],
  ];

  /** Which group rows are expanded. View state only — collapsing a group is
   *  not an edit and has no business in the manifest or in undo. */

  /* Whatever was just made has to be visible. Projects and Layouts are hidden
     with CSS rather than dropped from the markup, so their "+" sits outside the
     hidden list and stays pressable while the section is shut — and the new row
     landed somewhere the eye could not follow. Snapshots and Folders drop their
     whole block, "+" included, so this does not arise there. */


  /* Follow the pick into the list. One tile: open its row, so the wording and
     the picture it carries are right there — with forty-four rows the tile you
     just clicked on the wall is usually somewhere off-screen. Several: leave
     the rows shut, because twenty open editors is not a list any more, and
     only scroll to the topmost of them.

     The way to the row is opened too, not just the row. Both sections start
     collapsed, so a tile picked on the wall used to scroll to something that
     was not in the document at all — the follow silently did nothing on a
     fresh start, which is the moment it is needed most. A tile filed into a
     folder is reached through two twisties rather than one, and both are on
     the way. */
  /* Which selection this has already followed. Without it the effect fought
     the hand: it reads `open` to decide what to expand, so `open` is one of its
     dependencies — collapsing "On this wall" while a tile was still picked woke
     it, it saw a closed section under a live selection, and opened it again.
     The section could not be shut at all until the tile was deselected.

     Following is for the moment the selection changes. After that the sections
     are the reader's business. */
  let followed = "";

  $effect(() => {
    const picked = app.selectedTiles;
    if (!picked.length) {
      followed = "";
      return;
    }
    const mark = picked.join(",");
    if (mark === followed) return;
    followed = mark;
    const first = visibleIds().find((id) => picked.includes(id)) ?? picked[0];
    const drawer = folders().find((f) => f.tiles.includes(first));
    // A drawer is its own twisty and nothing above it: the Folders section it
    // used to sit under is gone, the drawers live in Tiles now.
    const path = drawer ? [drawer.id] : ["tiles"];
    if (path.some((key) => !isOpen(key))) for (const key of path) reveal(key);
    if (picked.length === 1 && !isOpen(picked[0])) toggleTileRow(picked[0]);
    // After the row exists, not before — opening it is what creates it.
    void tick().then(() =>
      document.querySelector(`[data-tile="${first}"]`)?.scrollIntoView({ block: "nearest" }),
    );
  });

  /* The accordion needs to know which rows count as siblings, and only the
     wall knows that. Spelled once here rather than at each of the three call
     sites, so the answer cannot differ between them. */


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
  async function stepName(e: KeyboardEvent, from: string, inGroup: string) {
    e.preventDefault();
    (e.currentTarget as HTMLInputElement).blur();
    const list = inGroup ? (folders().find((f) => f.id === inGroup)?.tiles ?? []) : looseIds();
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

  /** The sidebar's scroller, and whether it has travelled far enough that
   *  getting back to the top is worth a button rather than a flick. */
  let pane: HTMLElement | undefined = $state();
  let scrolled = $state(false);

  /** The row being renamed, "" for none. One at a time by construction. */
  let renaming = $state("");

  /** The wall canvas, for the one thing App needs from it: which tile is under
   *  a right-click. */
  let grid: GridCanvas | undefined = $state();

  /** An object URL for a stored asset, for the gallery thumbnails. Goes through
   *  the same loader the canvas uses, which caches per asset — so showing the
   *  same logo on twenty tiles costs one decode. */
  const assetUrl = (asset: string) => app.deps?.asset(asset) ?? Promise.resolve("");

  /** Paints a tile's untouched portrait into a small canvas.
   *
   *  Through `deps.original`, which is the same cached loader the wall uses, so
   *  a thumbnail costs no decode of its own. A canvas rather than an image
   *  element, because that loader hands back an ImageBitmap and there is no URL
   *  for one — and adding a second IO path for pictures the app already holds
   *  in memory would be a cache to keep in step for no gain. */
  function portrait(el: HTMLCanvasElement, arg: { id: string; ready: boolean }) {
    let live = true;
    let asked = "";

    /* Waits for the pixel source instead of shrugging at it. The overview is
       drawn from the manifest, which lands well before `app.deps` — the reader
       that knows how to fetch a portrait — so on a cold start every card asked
       a null and got nothing back. The action ran once per canvas and nothing
       ever tried again, which is why the squares stayed black for as long as
       you cared to wait. `ready` flips when the deps arrive and Svelte calls
       `update`, which is the retry. */
    const draw = async ({ id, ready }: { id: string; ready: boolean }) => {
      if (!ready || asked === id) return;
      asked = id;
      const bmp = await app.deps?.original(id);
      if (!live || !bmp) return;
      const ctx = el.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.drawImage(bmp, 0, 0, el.width, el.height);
    };

    /* Said out loud, on the same pictures the wall already reports. These are
       the user's own game files, so a read can genuinely fail — and with `void`
       in front, a thumbnail that could not be decoded looked exactly like a
       tile with nothing to show yet. Once per thumbnail: `asked` guards the
       reload, so a broken file cannot fill the line on every redraw. */
    const show = (next: { id: string; ready: boolean }) =>
      void draw(next).catch((e) => {
        app.error = `A portrait could not be drawn: ${e}`;
      });

    show(arg);
    return {
      update: show,
      destroy: () => (live = false),
    };
  }

  /** The never-seen-before ids that are still sitting in the inbox. Ones
   *  already sorted into a project are no longer news. */
  const freshHere = () => app.newTiles.filter((id) => !tileProject(id));

  /** Which wall the stage is showing, or the overview when none. */
  let home = $state(true);
  const enter = (id: string) => {
    openProjectView(id);
    home = false;
  };
  /* Back to the overview whenever a different folder is loaded: the walls it
     offers are the ones in that folder, and a project id from the last one
     names nothing here. */
  $effect(() => {
    app.dir;
    home = true;
  });

  /** Whether the strip of faces beside the Layout sheet is showing. On by
   *  default — the whole point is to see the design on a portrait — and
   *  collapsible for a narrow window, where it would eat the sheet's width. */
  let bedStrip = $state(true);


  /* Where a new layer lands. Inside a Layout it joins the sheet; on the wall it
   * goes onto every picked tile at once, which is what the sheet was the only
   * way to do. Nothing to insert into when neither is true — a layer has to
   * belong to something. */
  const insertInto = $derived(editing ? "layout" : app.selectedTiles.length ? "tiles" : "");
  const addImage = () => void (insertInto === "tiles" ? addTileImage() : addLayoutImage());
  const addText = () => void (insertInto === "tiles" ? addTileText() : addLayoutText());
  const addShape = (kind: ShapeKind, icon?: string) =>
    void (insertInto === "tiles" ? addTileShape(kind, icon) : addLayoutShape(kind, icon));
  /** What the insert buttons say they will do, so the same glyph landing in two
   *  different places is never a guess. */
  const insertWhere = $derived(
    insertInto === "tiles"
      ? ` onto ${app.selectedTiles.length} selected ${app.selectedTiles.length === 1 ? "tile" : "tiles"}`
      : insertInto === "layout"
        ? " into the layout"
        : "",
  );



  /** A holder's rows as the list draws them: topmost first, and without the
   *  live copies a Layout keeps there — the stamp row speaks for them. */
  const stampsOf = (layers: Layer[]) => [...layers].reverse().filter((l) => !isLiveCopy(l));

  /** A stamp shows its Layout's name; anything else falls back to layerLabel. */
  const stampName = (l: Layer) =>
    (l.kind === "image" && l.layoutId && layouts().find((x) => x.id === l.layoutId)?.name) ||
    layerLabel(l);

  const stampDirty = (l: Layer) => {
    if (l.kind !== "image" || !l.layoutId) return false;
    const layout = layouts().find((x) => x.id === l.layoutId);
    return !!layout && layoutNeedsRestamp(layout);
  };

  /** The picture spread across the open project's wall, if one is placed. It
   *  belongs to the wall rather than to any tile, so it gets its own section. */
  const wallLayers = $derived([...(openProject()?.gridLayers ?? [])].reverse());

  const layoutLayers = $derived(editing ? [...editing.layers].reverse() : []);

  /** The one layer the properties panel edits. Shown for a single pick only:
   *  with several selected the fields would have to merge differing values,
   *  which is a whole design of its own and nothing needs it yet. */
  const selectedLayoutLayer = $derived(
    editing && app.layoutSelection.length === 1
      ? findLayer(editing.layers, app.layoutSelection[0])
      : undefined,
  );

  /* One context menu serves both documents: the wall right-clicks tiles, the
     Layout editor right-clicks layers, and only the item list differs. */
  let menu: { x: number; y: number; items: Item[] } | null = $state(null);

  function wallMenu(e: MouseEvent) {
    if (editing) return;
    /* The tile under the cursor is the one meant, unless it is already part of
       the selection — then the selection is what was meant, and a right-click
       on one of several picked tiles still acts on all of them. Exactly the
       rule layerMenu states for rows, and the one every file manager uses.

       It used to re-target only when nothing at all was picked, so right-
       clicking tile A while B and C were selected quietly acted on B and C.
       GridCanvas answers which tile is there, since only it knows the
       viewport; right-clicking bare wall with a selection leaves it alone. */
    const under = grid?.tileAtEvent(e);
    if (under && !app.selectedTiles.includes(under)) app.selectedTiles = [under];
    if (!app.selectedTiles.length) return;
    e.preventDefault();
    const picked = app.selectedTiles.length;
    const elsewhere = projects().filter((p) => p.id !== app.openProjectId);
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          /* "free", not "picked": only tiles no project has claimed can start
             one, and the count said "New project from 0 tiles" with three
             portraits highlighted — true, and no help at all. Same name as the
             header button and the sidebar one, because it is the same action. */
          label:
            picked > 1
              ? `Project from ${freeCount()} free tile(s)`
              : "Project from selection",
          run: () => {
            reveal("projects");
            void newProjectFrom("");
          },
          disabled: !freeCount(),
        },
        ...(elsewhere.length ? [{ separator: true } as Item] : []),
        // Moving carries the tile's layers with it: artwork belongs to the
        // portrait, not to the wall it happens to be arranged on.
        ...elsewhere.map((p) => ({
          // Onto the shelf, not onto the grid: the target wall has an
          // arrangement and nothing here knows where in it the tile belongs.
          // The label used to leave that to be discovered.
          label: `Move to "${p.name}" shelf`,
          run: () => void moveTilesToProject(p.id),
        })),
        /* Assigning used to be one dropdown per row — forty-four visits to
           give a wall one design. The layouts are the same library the
           sidebar lists; this is only a second way in, on the selection. */
        /* Two rows rather than four per layout. With five designs the flat
           list ran to twenty entries and off the bottom of the screen, and
           adding "remove" would have doubled it again. Inside each submenu the
           selection comes first and the whole wall after a rule, which is the
           order the two are reached for in. */
        ...(layouts().length
          ? [
              { separator: true } as Item,
              {
                label: "Assign layout",
                items: [
                  ...layouts().map((l) => ({
                    label: picked === 1 ? `"${l.name}"` : `"${l.name}" to ${picked} tiles`,
                    run: () => void assignLayoutToSelection(l.id),
                  })),
                  /* And the whole wall in one item, for the case the selection
                     exists to serve: a second account's forty-four portraits,
                     all wanting the same design. Counted as work left to do —
                     a tile already wearing it is not offered a second stamp —
                     so the number vanishes once the wall is dressed. */
                  ...(layouts().some((l) => remainingFor(l.id).length)
                    ? [{ separator: true } as Item]
                    : []),
                  ...layouts()
                    .filter((l) => remainingFor(l.id).length)
                    .map((l) => ({
                      label: `"${l.name}" to all ${remainingFor(l.id).length} remaining`,
                      run: () => void assignLayoutToWall(l.id),
                    })),
                ],
              } as Item,
              /* Named per layout, unlike the blunt "clear everything" below:
                 a portrait can wear two designs, and taking the wrong one off
                 is not something to discover afterwards. Only the designs
                 actually on these tiles are offered — an item that would do
                 nothing is worse than no item. */
              {
                label: "Remove layout",
                disabled: !layouts().some((l) => wearing(l.id, app.selectedTiles).length),
                items: [
                  ...layouts()
                    .filter((l) => wearing(l.id, app.selectedTiles).length)
                    .map((l) => {
                      const n = wearing(l.id, app.selectedTiles).length;
                      return {
                        label: n === 1 ? `"${l.name}"` : `"${l.name}" from ${n} tiles`,
                        run: () => void removeLayoutFrom(l.id, [...app.selectedTiles]),
                      };
                    }),
                  ...(layouts().some((l) => wearing(l.id, visibleIds()).length)
                    ? [{ separator: true } as Item]
                    : []),
                  ...layouts()
                    .filter((l) => wearing(l.id, visibleIds()).length)
                    .map((l) => ({
                      label: `"${l.name}" from all ${wearing(l.id, visibleIds()).length} on this wall`,
                      run: () => void removeLayoutFrom(l.id, visibleIds()),
                    })),
                ],
              } as Item,
            ]
          : []),
        /* The inverse of the Assign items above, and blunter than they are:
           one item for the whole selection rather than one per layout, because
           a wall given the wrong design is undressed all at once or not at
           all. Counts what it would actually take, so a selection with nothing
           on it says so instead of offering a no-op. */
        { separator: true } as Item,
        {
          // Plain when it takes one tile, and when it can take none: "on 0
          // tiles" is a sentence no disabled item should have to say.
          label:
            strippableCount() > 1
              ? `Clear all layers on ${strippableCount()} tiles`
              : "Clear all layers",
          run: () => void clearLayers(),
          disabled: !strippableCount(),
        },
        ...(!app.openProjectId && picked
          ? [
              { separator: true } as Item,
              {
                /* BDO never deletes a portrait, so Unsorted only grows — this
                   is how a character who no longer exists stops being in the
                   way, without a file being touched. */
                label: picked === 1 ? "Archive" : `Archive ${picked} tiles`,
                run: () => void archiveSelection(true),
              },
            ]
          : []),
        ...(onArchive() && picked
          ? [
              { separator: true } as Item,
              {
                label: picked === 1 ? "Back to Unsorted" : `Put ${picked} back in Unsorted`,
                run: () => void archiveSelection(false),
              },
            ]
          : []),
        ...(app.openProjectId && !onArchive()
          ? [
              { separator: true } as Item,
              /* Only the drawers that would actually take something. One
                 already holding every picked tile offered "Put 3 in 'Done'"
                 with the three already in Done. */
              ...folders()
                .filter((f) => app.selectedTiles.some((id) => !f.tiles.includes(id)))
                .map((f) => ({
                  label: picked === 1 ? `Put in "${f.name}"` : `Put ${picked} in "${f.name}"`,
                  run: () => void fileSelectionInto(f.id),
                })),
              {
                label: picked === 1 ? "Put in a new folder" : `Put ${picked} in a new folder`,
                run: () => void newFolderHere(""),
              },
              { separator: true } as Item,
              {
                label: picked === 1 ? "Back to Unsorted" : `Send ${picked} back to Unsorted`,
                run: () => void releaseTilesToInbox(),
              },
            ]
          : []),
      ],
    };
  }



  /** Right-click in the Layout's layer list. Picks the row first when it is
   *  not already part of the selection, the way every list does. */
  function layerMenu(e: MouseEvent, layerId: string) {
    e.preventDefault();
    if (!app.layoutSelection.includes(layerId)) selectLayoutLayer(layerId);
    const picked = [...app.layoutSelection];
    const targets = layoutGroups().filter((g) => !picked.includes(g.id));
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: picked.length > 1 ? `Group ${picked.length} layers` : "Group",
          run: () => void groupLayoutLayers(),
          disabled: !canGroupLayers(),
        },
        ...(targets.length ? [{ separator: true } as Item] : []),
        ...targets.map((g) => ({
          label: `Move into "${layerLabel(g)}"`,
          run: () => void moveLayersIntoGroup(g.id, picked),
        })),
        { separator: true },
        {
          label: picked.length > 1 ? `Duplicate ${picked.length} layers (Ctrl+D)` : "Duplicate (Ctrl+D)",
          run: () => void duplicateLayoutLayers(),
        },
        /* Rename stays on the clicked row on purpose: there is one field to
           type into, and renaming three layers to the same thing is not a
           thing anyone wants. Delete does not — see below. */
        { label: "Rename", run: () => (renaming = layerId) },
        {
          /* The two items above act on the whole selection; this one used to
             take the clicked row alone and say nothing about it, so "Delete"
             under "Duplicate 2 layers" removed one of the two. */
          label:
            picked.length > 1
              ? `Delete ${picked.length} layers`
              : findLayer(editing?.layers ?? [], layerId)?.kind === "group"
                ? "Ungroup"
                : "Delete",
          run: () => void deleteLayoutLayers(picked),
        },
      ],
    };
  }
</script>

<!-- `change` is the browser's own "this control is finished" signal — it fires
     when a slider is released, a colour is chosen, a field is left or Enter is
     pressed — and it bubbles all the way up here. One listener therefore closes
     the undo run for every form control in the app, which is what lets history
     coalesce edits without a clock: a slider dragged in one go stays one step,
     and picking the same slider up again is a second one. Canvas gestures have
     no `change` event and call endGesture themselves. -->
<!-- The one moment a close costs work: saves are queued, so an edit made in
     the last instant may still be on its way to disk. The browser decides what
     the dialog says; all a page can do is ask for one. -->
<svelte:window
  onkeydown={shortcut}
  onchange={endGesture}
  onbeforeunload={(e) => {
    if (savePending()) e.preventDefault();
  }}
/>

<!-- A few portraits off a wall, so a card is recognisable without being
     opened. Four is enough to tell two accounts apart and cheap enough that the
     overview costs nothing; the rest is a count. -->
{#snippet thumbs(ids: string[])}
  <span class="strip">
    {#each ids.slice(0, 4) as id (id)}
      <canvas class="thumb" width="39" height="50" use:portrait={{ id, ready: !!app.deps }}></canvas>
    {/each}
    {#if ids.length > 4}<span class="more">+{ids.length - 4}</span>{/if}
  </span>
{/snippet}

<!-- One Layout row per layer, recursing into groups. A snippet rather than a
     component because it needs nothing but the list it draws, and a component
     would mean threading every action through props. -->
{#snippet layerRows(rows: Layer[], nested: boolean, parentId: string | null)}
  <ul class:indent={nested}>
    {#each rows as layer (layer.id)}
      <li
        class:selected={app.layoutSelection.includes(layer.id)}
        aria-current={app.layoutSelection.includes(layer.id) ? "true" : undefined}
        class:drop-before={drag.on?.id === layer.id && drag.on.where === "before"}
        class:drop-after={drag.on?.id === layer.id && drag.on.where === "after"}
        class:drop-into={drag.on?.id === layer.id && drag.on.where === "into"}
        draggable="true"
        ondragstart={(e) => startDrag(e, layer.id)}
        ondragover={(e) => over(e, layer.id, layer.kind === "group")}
        ondragleave={() => drag.on?.id === layer.id && (drag.on = null)}
        ondragend={endDrag}
        ondrop={(e) => {
          e.preventDefault();
          const spot = drag.on;
          const moving = drag.id;
          endDrag();
          if (!spot || !moving) return;
          const spotIn = landing(rows, spot.id, spot.where, parentId);
          void dropLayoutLayer(moving, spotIn.parentId, spotIn.beforeId);
        }}
        oncontextmenu={(e) => layerMenu(e, layer.id)}
      >
        <button
          class="eye"
          title={layer.hidden ? "Show" : "Hide"}
          onclick={() => toggleLayoutLayerHidden(layer.id)}
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
        {#if renaming === layer.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="rename"
            autofocus
            onfocus={selectAll}
            value={layerLabel(layer)}
            onblur={(e) => {
              void renameLayer(layer.id, e.currentTarget.value);
              renaming = "";
            }}
            onkeydown={(e) => renameKey(e, layerLabel(layer))}
          />
        {:else}
          <button
            class="name"
            class:dimmed={layer.hidden}
            class:group-name={layer.kind === "group"}
            onclick={(e) => toggleLayoutPick(layer.id, e.ctrlKey || e.shiftKey)}
            ondblclick={() => (renaming = layer.id)}
            title="Ctrl-click picks several, double-click renames"
          >
            <!-- No ▾ here. Everywhere else in this sidebar that glyph is a
                 twisty you can press; on a group row it was plain text in the
                 middle of a name button, and groups do not collapse. The
                 group-name class carries the distinction instead. -->
            {layerLabel(layer)}
          </button>
        {/if}
        <button
          title="Duplicate (Ctrl+D)"
          onclick={() => {
            selectLayoutLayer(layer.id);
            void duplicateLayoutLayers();
          }}>⧉</button
        >
        <button
          title={layer.kind === "group" ? "Ungroup, the layers stay" : "Delete"}
          onclick={() => deleteLayoutLayer(layer.id)}>×</button
        >
      </li>
      {#if layer.kind === "group"}
        {@render layerRows([...layer.children].reverse(), true, layer.id)}
      {/if}
    {/each}
  </ul>
{/snippet}







<main>
  <header>
    <div class="docs" role="group" aria-label="Document">
      <button
        class:active={!editing && home}
        onclick={() => {
          closeLayoutDoc();
          home = true;
        }}
        disabled={!app.dir}>Home</button
      >
      {#if !home}
        {@const project = openProject()}
        {#if project && renaming === `proj:${project.id}`}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="rename"
            autofocus
            onfocus={selectAll}
            value={project.name}
            onblur={(e) => {
              void renameProject(project.id, e.currentTarget.value);
              renaming = "";
            }}
            onkeydown={(e) => renameKey(e, project.name)}
          />
        {:else}
          <!-- Same gesture as the layout tab beside it: double-click renames,
               right where the name is read. Unsorted is nobody's project and
               keeps its name. -->
          <button
            class:active={!editing}
            onclick={closeLayoutDoc}
            ondblclick={() => project && (renaming = `proj:${project.id}`)}
            title={project ? "Double-click renames" : undefined}
            disabled={!app.dir}
          >
            {project?.name ?? "Unsorted"}
          </button>
        {/if}
      {/if}
      <!-- The way to see a folder that changed underneath us. The portraits are
           read once, at startup, and cached for the session — so a restore, or
           files copied into the folder by hand, used to need the app closed and
           opened again before the wall showed what is actually on disk. -->
      <button
        class="reload"
        onclick={() => void openFolder()}
        disabled={!app.dir || !!app.busy}
        title="Reads the game folder again — for portraits changed outside Tessera. Layers and arrangement stay; it lands on Home and clears the undo history."
        aria-label="Reload the folder"
      >
        ↻
      </button>
      <!-- Both ways in: the button so it can be found without knowing anything,
           the key so it can be reached without looking. -->
      <button
        class="reload help"
        onclick={() => (keysOpen = true)}
        title={newer ? `Keyboard and mouse (?) — ${newer} is out` : "Keyboard and mouse (?)"}
        aria-label={newer
          ? `Keyboard and mouse shortcuts — version ${newer} is available`
          : "Keyboard and mouse shortcuts"}
      >
        ?
        <!-- The only thing on screen that says a new version exists. The sheet
             behind this button is where the version lives, and nobody opens a
             shortcut sheet to check for updates — so the news has to be on the
             button. Red rather than the amber used for "layout changed": two
             marks that mean different things must not look alike. -->
        {#if newer}<span class="fresh" aria-hidden="true"></span>{/if}
      </button>
    </div>

      <!-- Every button below acts on the wall in front of you, and on the
           overview there is none. The open project is deliberately remembered
           while Home shows — that is what makes the way back one click — so
           these cannot ask openProject() whether there is a wall; only `home`
           knows. -->
      <!-- The one disabled button in this row that explained nothing — and the
           one the empty state points at. -->
      <button
        onclick={() => {
          reveal("projects");
          void newProjectFrom("");
        }}
        disabled={!freeCount() || !!app.busy || home}
        title={home
          ? "Open Unsorted first, then pick the portraits of one account"
          : freeCount()
            ? `Builds a wall from the ${freeCount()} picked tile(s) no project has claimed`
            : "Pick tiles that no project has claimed yet"}
      >
        Project from selection
        {#if freeCount()}({freeCount()}){/if}
      </button>
      <button
        onclick={addGridImage}
        disabled={!canAddGridImage() || !!app.busy || home}
        title={canAddGridImage()
          ? "A picture spread across this wall — opens a file picker"
          : "Open a project first — a wall picture belongs to a wall"}
      >
        Image across the wall…
      </button>
      <!-- The count is the point. Baking skips any tile the picture does not
           cover completely — a tile's base is a full-bleed crop, so half of one
           cannot be stored — and that rule used to be invisible until the wall
           came back with a row missing. A new picture starts "as wide as the
           grid", which on a seven-row wall reaches only the middle rows. -->
      <!-- One press for the guarantee. The picture keeps its proportions, so
           whichever axis falls short decides the size and the other overhangs
           — there is no arrangement that lays all four edges on the wall's
           unless the shapes happen to match. Dragging afterwards snaps to
           those edges, with Alt to override. -->
      <button
        onclick={coverTheWall}
        disabled={!canBakeMosaic() || !!app.busy || home}
        title="Sizes and centres the picture so every tile lies under it"
      >
        Cover the wall
      </button>
      <button
        onclick={bakeMosaic}
        disabled={!canBakeMosaic() || !!app.busy || home}
        title={canBakeMosaic()
          ? `${coverCounts().covered} of ${coverCounts().total} tiles lie fully under the picture; the outlined ones are what Apply bakes`
          : "Select a wall picture first"}
      >
        Apply{#if canBakeMosaic()}&nbsp;({coverCounts().covered}/{coverCounts().total}){/if}
      </button>
      <!-- The way back out of that bake. A baked background hides the portrait
           completely — background() never reads the file while one is set — so
           without this a mosaic applied in some earlier session leaves a wall
           that looks like the app cannot load its own folder. The count is in
           the label because the button takes the whole wall at once; one
           Ctrl+Z puts it back. -->
      <button
        onclick={clearMosaic}
        disabled={!bakedCount() || !!app.busy || home}
        title="Removes the baked mosaic from every tile, so the portraits show again"
      >
        Restore portraits{#if bakedCount()}&nbsp;({bakedCount()}){/if}
      </button>
      <button
        class="primary"
        onclick={writeToGame}
        disabled={!canSaveToGame() || !!app.busy || home}
        title={canSaveToGame()
          ? "Writes this project's placed tiles into the game folder"
          : "Open a project with tiles on its grid — Unsorted is not a wall"}
      >
        Write to game
      </button>
      <!-- The way back into the game, not out of the work: this writes the
           vaulted originals over the game's files and touches neither a layer
           nor an arrangement, so Write to game puts everything straight back.
           Not undoable, because nothing in the document changed — which is
           exactly why it asks first. -->
      <button
        onclick={resetProject}
        disabled={!restorableCount() || !!app.busy || home}
        title={restorableCount()
          ? "Puts the game's own portraits back for this project; your layers stay"
          : "Open a project first"}
      >
        Reset in game
      </button>

    <span class="status">
      {#if app.busy}
        {app.busy}…
      {:else if app.error}
        {app.error}
      {:else if app.selectedTiles.length}
        <!-- The second half only where it can be anything but zero. Inside a
             project every picked tile is claimed by definition, so it read
             ", 0 of them unassigned" on every single selection. -->
        {app.selectedTiles.length} selected{#if !app.openProjectId && freeCount() < app.selectedTiles.length}, {freeCount()}
          of them unassigned{/if}
        <button class="link" onclick={clearTiles}>clear</button>
      {:else if app.dir && home}
        <!-- The overview has cards, not a canvas: naming the wall you are not
             looking at and advertising drag gestures that do nothing there was
             the line that made "Home" feel like it had not left the project. -->
        {projects().length} project(s) &middot; {inbox().length} unassigned
      {:else if app.dir}
        {openProject()?.name ?? "Unsorted"} &middot; {visibleIds().length}
        {visibleIds().length === 1 ? "tile" : "tiles"} &middot; drag selects, Ctrl adds, Alt+drag
        swaps
      {/if}
    </span>
  </header>

  <div class="body">
    <!-- One fixed toolbar for both views, two columns: the left column holds
         the horizontal half of a pair, the right the vertical. Fixed rather
         than appearing with the mode: a control with a permanent home can be
         found before it is needed, and greying out says "open a Layout first"
         better than absence does. -->
    <div class="tools" role="toolbar" aria-label="Tools">
      {#snippet tool(label: string, glyph: string, run: () => void, off: boolean)}
        <button title={label} disabled={off || !!app.busy} onclick={run}>{glyph}</button>
      {/snippet}
      <!-- Named, so the button says what it is about to take back rather than
           leaving you to press it and find out. Ctrl+Z on a wall of forty-four
           portraits can reach anywhere; every other edit tells you what it
           touched by touching it. -->
      {@render tool(
        undoLabel() ? `Undo ${undoLabel().toLowerCase()} (Ctrl+Z)` : "Undo (Ctrl+Z)",
        "↶",
        () => void undoEdit(),
        !undoable(),
      )}
      {@render tool(
        redoLabel() ? `Redo ${redoLabel().toLowerCase()} (Ctrl+Y)` : "Redo (Ctrl+Y)",
        "↷",
        () => void redoEdit(),
        !redoable(),
      )}
      <span class="gap"></span>
      <!-- The wall's one mode, and the only button in this rail that stays
           pressed. Its own group under the undo pair, away from the insert
           tools: those add a layer to a Layout, this changes what a drag on the
           wall means. A crop frame with a picture's diagonal inside it — the
           mark every editor uses for "which part of this shows". -->
      <button
        class="mode"
        class:on={framing}
        aria-pressed={framing}
        onclick={() => (framing = !framing)}
        disabled={home || !!editing || !!app.busy}
        title={framing
          ? "Placing: pick a tile, then one of its own layers in the list — drag it, corners zoom, the top handle turns. Escape leaves"
          : "Place a tile's own layers — its picture, caption or class icon"}
      >
        <RowIcon name="place" size={17} />
      </button>
      <span class="gap"></span>
      <!-- Framed mountain and sun, the icon every editor uses for a picture —
           no Unicode glyph reads as one at this size. -->
      <button
        title={`Insert image${insertWhere} — opens a file picker`}
        disabled={!insertInto || !!app.busy}
        onclick={addImage}
      >
        <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
          <rect x="1" y="1" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <circle cx="5.4" cy="5" r="1.4" fill="currentColor" />
          <path d="M3 11.4 L7 7 L9.5 9.6 L11.5 7.6 L13.6 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
      </button>
      {@render tool(`Insert text${insertWhere}`, "T", addText, !insertInto)}
      {@render tool(`Rectangle${insertWhere}`, "▭", () => addShape("rect"), !insertInto)}
      {@render tool(`Ellipse${insertWhere}`, "◯", () => addShape("ellipse"), !insertInto)}
      {@render tool(`Polygon${insertWhere}`, "⬡", () => addShape("polygon"), !insertInto)}
      <!-- The fourth shape. A picker rather than a straight insert, because
           which class it is is the whole question. -->
      {@render tool(`Class icon${insertWhere}`, "✦", () => (iconsOpen = true), !insertInto)}
      <span class="gap"></span>
    </div>

    <!-- Capture phase: Fabric stops contextmenu on its own canvas, so a
         bubbling listener out here never sees a right-click on the wall.
         Capture runs on the way down, before the target's own handlers. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- The wall is the drop target for a shelved tile. GridCanvas already
         knows how to turn a screen point into a cell (tileAtEvent), so the drop
         only has to ask it which portrait it landed on and place the carried
         tile in front of that one — or at the end, past the last. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="stage"
      class:dropping={!!drag.tile}
      oncontextmenucapture={wallMenu}
      ondragover={(e) => drag.tile && e.preventDefault()}
      ondrop={(e) => {
        e.preventDefault();
        const moving = drag.tile;
        drag.tile = "";
        if (moving) void placeTileAt(moving, grid?.tileAtEvent(e) || null);
      }}
    >
      {#if home}
        <!-- The start view, always. With several accounts sharing one folder
             there is no single "the" wall to open, and a newly created
             character has to be visible the moment it turns up — so the way in
             is a choice of wall rather than a guess at one. -->
        <div class="home">
          <div class="cards">
            <button class="card inbox" onclick={() => enter("")}>
              <span class="cardname">
                Unsorted
                <!-- Ids this folder had never shown us before: a first run, or
                     characters made since the last one. Not a problem to solve
                     — just something that must not be missed in a list of
                     forty-four. -->
                {#if freshHere().length}<span class="badge">{freshHere().length} new</span>{/if}
              </span>
              <!-- The same word the sidebar uses for the same number. The card
                   said "waiting", Projects said "unassigned" and the tile list
                   said neither — three names for one count on one screen. -->
              <span class="cardsub">{inbox().length} unassigned</span>
              {@render thumbs(inbox())}
            </button>
            <!-- Only when there is something in it. A permanently empty card for
                 a folder nobody has put anything away from would be a control
                 that never does anything; the archive earns its place by
                 holding something. Last in the row and quiet, because put away
                 should look put away. -->
            {#if archived().length}
              <button class="card away" onclick={() => enter(ARCHIVE)}>
                <span class="cardname">Archive</span>
                <span class="cardsub">{archived().length} put away</span>
                {@render thumbs(archived())}
              </button>
            {/if}
            {#each projects() as project (project.id)}
              <button class="card" onclick={() => enter(project.id)}>
                <span class="cardname">{project.name}</span>
                <span class="cardsub">
                  {project.order.length} placed{#if project.shelf.length}&nbsp;&middot;
                    {project.shelf.length} shelved{/if}
                </span>
                {@render thumbs(project.order)}
              </button>
            {/each}
          </div>
          {#if !projects().length}
            <p class="empty">
              Open Unsorted, pick the portraits of one account, then "Project from selection".
            </p>
          {/if}
          {#if changedHere().length}
            <!-- The one question the app cannot answer for itself. BDO keeps a
                 character's numeric id when a slot is deleted and refilled, so
                 "the file changed" means either a restyle or a stranger — and
                 the bytes look the same in both cases. Answering it wrong
                 either throws away a design or leaves someone else wearing it,
                 so it is asked once, per tile, before anything is touched.

                 Below the walls, not above: the cards are the room's furniture
                 and every visit leans on them, while this list only exists on
                 the mornings the game rewrote something. -->
            <div class="alert">
              <p class="alerthead">
                {changedHere().length} portrait(s) changed in the game since you were last here.
              </p>
              <p class="empty">
                Same character with a new look, or a different character in that slot? Nothing is
                touched until you say.
              </p>
              <!-- The mass answers, for the day the game regenerates the whole
                   folder. "All same" deliberately keeps the vault copies: a
                   wholesale rewrite is not a restyle, and the vault is the one
                   thing that answer must not eat. A face that truly changed
                   still has its stricter per-tile button below. -->
              <div class="row">
                <button
                  title="Record every file as the same character — layers and vault copies stay"
                  disabled={!!app.busy}
                  onclick={() => void keepAllCharacters()}
                >
                  All same characters
                </button>
                <button
                  title="Strip every listed tile and send it back to Unsorted"
                  disabled={!!app.busy}
                  onclick={allNewCharacters}
                >
                  All new characters
                </button>
              </div>
              <ul>
                {#each changedHere() as id (id)}
                  <li>
                    <canvas class="thumb" width="31" height="40" use:portrait={{ id, ready: !!app.deps }}></canvas>
                    <button class="name">
                      {id}
                      <span class="usage">
                        {tileProject(id)?.name ?? "unsorted"} ·
                        {tileLayers(id).length} layer(s)
                      </span>
                    </button>
                    <button title="Keep the layers on it" onclick={() => keepCharacter(id)}>
                      Same character
                    </button>
                    <button
                      title="Strip it and send it back to Unsorted"
                      onclick={() => replaceCharacter(id)}
                    >
                      New character
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      {:else}
        <GridCanvas bind:this={grid} {framing} />
      {/if}
    </div>

    <aside bind:this={pane} onscroll={() => (scrolled = pane!.scrollTop > 200)}>
      {#if editing}
        <h2>Layers in the layout</h2>
        {#if !layoutLayers.length}
          <p class="empty">No layers.</p>
        {/if}
        {@render layerRows(layoutLayers, false, null)}
        {#if layoutLayers.length}
          <!-- Only with something to right-click on. Under "No layers." it read
               as an instruction for the empty list itself. -->
          <p class="empty">Right-click a layer to group, duplicate, rename or delete.</p>
        {/if}
        {#if selectedLayoutLayer}
          <Properties
            layer={selectedLayoutLayer}
            inLayout
            onPickClass={(layerId) => {
              iconTarget = { layer: layerId };
              iconsOpen = true;
            }}
          />
        {/if}
      {:else}
        {#if wallLayers.length}
          <h2>Wall</h2>
          <ul>
            {#each wallLayers as layer (layer.id)}
              <li
                class:selected={app.selected === layer.id}
                aria-current={app.selected === layer.id ? "true" : undefined}
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
                <button class="name" class:dimmed={layer.hidden} onclick={() => selectLayer(layer.id)}>
                  {layerLabel(layer)}
                </button>
                <button title="Delete" onclick={() => deleteLayer(layer.id)}>×</button>
              </li>
            {/each}
          </ul>
        {/if}

        <!-- One wall per project. The FaceTexture folder is shared by every
             account on the machine, so which portraits belong together is a
             thing only the user knows — the inbox is whatever no project has
             claimed, and it is where a newly created character turns up. -->
        <h2 class:spaced={wallLayers.length}>
          <button class="head" onclick={() => toggleOpen("projects")} aria-expanded={isOpen("projects")}>
            <span class="twisty inline">{isOpen("projects") ? "▾" : "▸"}</span>
            Projects
          </button>
        </h2>
        <ul class:collapsed={!isOpen("projects")}>
          <li class:selected={!app.openProjectId} aria-current={!app.openProjectId ? "true" : undefined}>
            <button class="name" onclick={() => enter("")}>
              Unsorted
              <span class="usage">
                {inbox().length} unassigned{#if !inbox().length} · all sorted{/if}
              </span>
            </button>
          </li>
          {#each projects() as project (project.id)}
            <li
              class:selected={app.openProjectId === project.id}
              aria-current={app.openProjectId === project.id ? "true" : undefined}
            >
              {#if renaming === project.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="rename"
                  autofocus
                  onfocus={selectAll}
                  value={project.name}
                  onblur={(e) => {
                    void renameProject(project.id, e.currentTarget.value);
                    renaming = "";
                  }}
                  onkeydown={(e) => renameKey(e, project.name)}
                />
              {:else}
                <button
                  class="name"
                  onclick={() => enter(project.id)}
                  ondblclick={() => (renaming = project.id)}
                  title="Click opens this wall, double-click renames"
                >
                  {project.name}
                  <span class="usage">
                    {project.order.length} placed{#if project.shelf.length}&nbsp;&middot;
                      {project.shelf.length} shelved{/if}
                  </span>
                </button>
              {/if}
              <button title="Delete project" onclick={() => removeProject(project.id, project.name)}
                >×</button
              >
            </li>
          {/each}
        </ul>
        <!-- Inside its section too, for the same reason. `reveal` stays on the
             two ways in from outside — the header button and the wall's own
             menu — where the section may well be shut. -->
        {#if isOpen("projects")}
          <button
            class="wide"
            onclick={() => void newProjectFrom("")}
            disabled={!freeCount() || !!app.busy}
            title="Builds a wall from the picked tiles that no project has claimed"
          >
            + Project from selection{#if freeCount()}&nbsp;({freeCount()}){/if}
          </button>
        {/if}

        <!-- One library across every project: a design fits characters from
             any account, and keeping a copy per wall would mean editing the
             same frame twice. Collapsible, because that library is the list
             that grows without bound. -->
        <h2 class="spaced">
          <button class="head" onclick={() => toggleOpen("layouts")} aria-expanded={isOpen("layouts")}>
            <span class="twisty inline">{isOpen("layouts") ? "▾" : "▸"}</span>
            Layouts{#if layouts().length}&nbsp;({layouts().length}){/if}
          </button>
        </h2>
        {#if !layouts().length}
          <p class="empty">None yet.</p>
        {/if}
        <ul class:collapsed={!isOpen("layouts")}>
          {#each layouts() as layout (layout.id)}
            <li>
              {#if renaming === layout.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="rename"
                  autofocus
                  onfocus={selectAll}
                  value={layout.name}
                  onblur={(e) => {
                    void renameLayout(layout.id, e.currentTarget.value);
                    renaming = "";
                  }}
                  onkeydown={(e) => renameKey(e, layout.name)}
                />
              {:else}
                <!-- Double-click renames, like a group row — and opening lives
                     on the pencil, not on the name. Both cannot share the
                     name: the first click of a double-click would open the
                     document, unmount this row, and the second click would
                     land on nothing, which is exactly how layouts were
                     unrenamable for a while. -->
                <!-- The same dot the stamp rows carry, one level up. Those are
                     inside a tile that has to be expanded to be seen, so
                     closing a Layout after editing left the wall looking
                     finished while it was showing older art.

                     And it is the button now. It used to be a span inside the
                     name, whose tooltip read "open it and press Update stamps"
                     — an instruction to go somewhere else and press a button,
                     printed on the exact spot the eye was already on.
                     saveLayout has been keyed by id for a while, so there was
                     nothing to open. A button cannot be nested in a button,
                     which is why it moved out here rather than growing an
                     onclick where it stood.

                     Before the name, because the name is what gets ellipsised
                     and a dot behind "…" is no dot at all. -->
                {#if canSaveLayout(layout.id)}
                  <button
                    class="dirty"
                    disabled={!!app.busy}
                    title="Stamps are older than this Layout — press to update them"
                    onclick={() => void saveLayout(layout.id)}>●</button
                  >
                {/if}
                <!-- `inert-name`, because it is the one name button in this
                     sidebar a single click does nothing with, and it looked
                     exactly like the ones that respond. -->
                <button
                  class="name inert-name"
                  ondblclick={() => (renaming = layout.id)}
                  title="Double-click to rename — the pencil opens it"
                >
                  {layout.name}
                  <!-- Both numbers, because they answer different questions:
                       the stamps are what a refresh or a delete touches, the
                       tiles are how much of the wall wears the design. One
                       group of fifteen tiles used to read "stamped 1 time". -->
                  <span class="usage">
                    <!-- One number. It read "1 stamp(s) · 1 tile(s)" because
                         the two were the same count wearing different words —
                         see tilesWearing. -->
                    {layoutTiles(layout.id) ? `${layoutTiles(layout.id)} tile(s)` : "unused"}
                  </span>
                </button>
              {/if}
              <button title="Edit layout" onclick={() => openLayoutDoc(layout.id)}>✎</button>
              <!-- No shortcut in the tooltip: Ctrl+D duplicates the picked
                   layers inside a Layout, and this copies the whole Layout. -->
              <button title="Duplicate" onclick={() => duplicateLayoutDoc(layout.id)}>⧉</button>
              <button title="Delete" onclick={() => removeLayout(layout.id, layout.name)}>×</button
              >
            </li>
          {/each}
        </ul>
        <!-- Inside the section, like every other "+". It sat outside because
             the list above is hidden with CSS rather than dropped, so the
             button stayed on screen under a collapsed heading and offered to
             add to a list nobody could see. -->
        {#if isOpen("layouts")}
          <button
            class="wide"
            onclick={() => void newLayoutDoc(`Layout ${layouts().length + 1}`)}
            disabled={!app.dir || !!app.busy}
          >
            + New layout
          </button>
        {/if}

        <!-- A wall put aside under a name, so it can be tried out and walked
             back from. Twenty kilobytes each — the assets and the vault copies
             a snapshot names are never deleted, so restoring one finds them all
             still there.

             The list belongs to the wall in front of you: another account's
             rollback points are not an offer worth showing here, and taking one
             by mistake would rearrange a wall you are not looking at. On the
             overview it is the document-wide ones instead. -->
        <h2 class="spaced">
          <button class="head" onclick={() => toggleOpen("snapshots")} aria-expanded={isOpen("snapshots")}>
            <span class="twisty inline">{isOpen("snapshots") ? "▾" : "▸"}</span>
            Snapshots{#if snapshots().length}&nbsp;({snapshots().length}){/if}
          </button>
        </h2>
        {#if isOpen("snapshots")}
          {#if !snapshots().length}
            <p class="empty">
              {app.openProjectId ? "None for this project yet." : "None yet."}
            </p>
          {/if}
          <ul>
            {#each snapshots() as snap (snap.name)}
              <li>
                {#if renaming === `snap:${snap.name}`}
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    class="rename"
                    autofocus
                    onfocus={selectAll}
                    value={snap.name}
                    onblur={(e) => {
                      void renameSnapshot(snap, e.currentTarget.value);
                      renaming = "";
                    }}
                    onkeydown={(e) => renameKey(e, snap.name)}
                  />
                {:else}
                  <button
                    class="name"
                    title="Double-click to rename"
                    ondblclick={() => (renaming = `snap:${snap.name}`)}>{snap.name}</button
                  >
                {/if}
                <!-- The document only. What sits in the game folder is a
                     separate decision, and "Write to game" is where it is made. -->
                <button
                  title={snap.projectId
                    ? "Put this wall back as it was — other projects and the game folder are not touched"
                    : "Put the whole document back — the game folder is not touched"}
                  disabled={!!app.busy}
                  onclick={() => void putBack(snap)}>↺</button
                >
                <!-- Asks, unlike the other × in this sidebar. A snapshot is the
                     one thing here with no undo behind it and no second copy,
                     and this button sits two pixels from the one that restores
                     it — the pair most likely to be hit by mistake. -->
                <button title="Delete" onclick={() => void dropSnapshot(snap)}>×</button>
              </li>
            {/each}
          </ul>
          <button
            class="wide"
            disabled={!app.dir || !!app.busy}
            onclick={async () => {
              const name = nextSnapshotName();
              await takeSnapshot(name);
              renaming = `snap:${name}`;
            }}
          >
            <!-- Named for its reach. On the Unsorted wall there is no project
                 to scope to, so the same button in the same place takes the
                 whole document — which is a different promise. -->
            + Snapshot{app.openProjectId ? "" : " (whole document)"}
          </button>
        {/if}

        <!-- Every edit still remembered, newest first, with a line where you
             are standing. Ctrl+Z already says what it will take back, but only
             one step ahead; this is the same information for all two hundred,
             and clicking a row goes there in one move instead of holding Ctrl+Z
             and watching the wall flicker past what you wanted.

             Undone edits stay on the list above the line rather than
             disappearing, because "what did I just take back" is exactly the
             question a redo button cannot answer. -->
        <h2 class="spaced">
          <button class="head" onclick={() => toggleOpen("history")} aria-expanded={isOpen("history")}>
            <span class="twisty inline">{isOpen("history") ? "▾" : "▸"}</span>
            History{#if historySteps().length}&nbsp;({historySteps().length}){/if}
          </button>
        </h2>
        {#if isOpen("history")}
          {#if !historySteps().length}
            <p class="empty">Nothing done yet.</p>
          {:else}
            <ul>
              {#each historySteps() as step, i (i)}
                <!-- The line is drawn on the first row still in force rather
                     than as a row of its own: a separator that can be clicked
                     is a row, and there is no state to go to at "now". -->
                <li class="step" class:undone={!step.done} class:now={step.done && step.delta === -1}>
                  <button
                    class="name"
                    title={step.done
                      ? `Go back to before "${step.label}"`
                      : `Put "${step.label}" back`}
                    onclick={() => void jumpEdit(step.delta)}>{step.label}</button
                  >
                </li>
              {/each}
            </ul>
          {/if}
        {/if}

        {#if shelfIds().length}
          <!-- Collected but not placed. Sorting a wall is two jobs — decide
               which portraits belong to it, then decide where each one sits —
               and this is the pile between them. Drag a row onto the wall to
               give it a slot; it lands in front of whatever it is dropped on. -->
          <h2 class="spaced">Shelf</h2>
          <ul>
            {#each shelfIds() as id (id)}
              <li
                class="shelfrow"
                draggable="true"
                ondragstart={(e) => {
                  drag.tile = id;
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                }}
                ondragend={() => (drag.tile = "")}
              >
                <canvas class="thumb" width="31" height="40" use:portrait={{ id, ready: !!app.deps }}></canvas>
                <button
                  class="name"
                  onclick={(e) => toggleTile(id, { ctrl: e.ctrlKey, shift: e.shiftKey })}>{id}</button
                >
                <button title="Put it at the end of the wall" onclick={() => placeTileAt(id, null)}
                  >↦</button
                >
              </li>
            {/each}
          </ul>
          <p class="empty">Drag onto the wall to choose the slot.</p>
        {/if}

        <!-- Folders: drawers for finished portraits, so a wall of forty-four
             rows stays scannable. Named for what the model has always called
             them: "Group" was taken twice over — a drawer of tiles here and a
             real stack of layers in the Layout — and the two behave nothing
             alike. Purely cosmetic — a folder renders nothing, owns nothing,
             and dissolving one leaves every tile exactly where it was.
             Inside Tiles rather than beside it: a drawer holds tiles off this
             wall, so a heading of its own put half the wall's portraits under
             one word and half under another. Each drawer keeps its own twisty,
             which is the only collapsing this needed. -->
        <h2 class="spaced">Tiles</h2>
        {#each folders() as folder (folder.id)}
          <div
            class="group"
            role="presentation"
            onmouseenter={() => (app.hoverFolder = folder.id)}
            onmouseleave={() => (app.hoverFolder = "")}
          >
            <div class="grouphead">
              <button class="twisty" onclick={() => toggleOpen(folder.id)}>
                {isOpen(folder.id) ? "▾" : "▸"}
              </button>
              {#if renaming === folder.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="rename"
                  autofocus
                  onfocus={selectAll}
                  value={folder.name}
                  onblur={(e) => {
                    void renameFolder(folder.id, e.currentTarget.value);
                    renaming = "";
                  }}
                  onkeydown={(e) => renameKey(e, folder.name)}
                />
              {:else}
                <button
                  class="name"
                  onclick={() => toggleOpen(folder.id)}
                  ondblclick={() => (renaming = folder.id)}
                  title="Double-click to rename · hover outlines its tiles"
                >
                  {folder.name}
                  <span class="usage">{folder.tiles.length} tile(s)</span>
                </button>
              {/if}
              <button
                title="Put the picked tiles in here"
                disabled={!app.selectedTiles.length}
                onclick={() => {
                  for (const id of app.selectedTiles) void fileTile(id, folder.id);
                }}>+</button
              >
              <!-- Dissolve, not delete: the tiles keep their slots and every
                   layer on them. That is the whole difference from the group
                   this replaced, where the same click threw artwork away. -->
              <button title="Dissolve — the tiles stay" onclick={() => removeFolder(folder.id)}
                >×</button
              >
            </div>
            {#if isOpen(folder.id)}
              <div class="indent">
                {#each folder.tiles as id (id)}
                  <TileRow {id} inGroup={folder.id} bind:framing {openIcons} />
                {/each}
              </div>
            {/if}
          </div>
        {/each}

        <!-- The loose pile, after the drawers: what is filed away reads as a
             heading and what is not reads as the list under it. -->
        <div class="group">
          <div class="grouphead">
            <button class="twisty" onclick={() => toggleOpen("tiles")}>
              {isOpen("tiles") ? "▾" : "▸"}
            </button>
            <button class="name" onclick={() => toggleOpen("tiles")}>
              {app.openProjectId ? "On this wall" : "Unsorted"}
              <span class="usage">{looseIds().length} · right-click the wall to assign several</span>
            </button>
          </div>

          {#if isOpen("tiles")}
            <div class="indent">
              {#each looseIds() as id (id)}
                <TileRow {id} inGroup="" bind:framing {openIcons} />
              {/each}
            </div>
          {/if}
        </div>

        <!-- Last in the section, where every other "+" in this sidebar sits.
             It makes a drawer out of whatever is picked, so it belongs under
             both lists rather than between them. -->
        {#if openProject()}
          <button
            class="wide"
            onclick={() => newFolderHere("")}
            disabled={!!app.busy}
            title="A drawer for finished tiles, so the list stays short"
          >
            + New folder{#if app.selectedTiles.length}&nbsp;({app.selectedTiles.length}){/if}
          </button>
        {/if}

      {/if}
      <!-- The way back up. Only once there is a way back: a button that is
           always there is furniture, one that appears when you have travelled
           says something. -->
      {#if scrolled}
        <button
          class="totop"
          title="Back to the top"
          onclick={() => pane?.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M7 11.5V3M3.2 6.6 7 2.8l3.8 3.8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      {/if}
    </aside>
  </div>

  {#if menu}
    <ContextMenu {...menu} onclose={() => (menu = null)} />
  {/if}
</main>

<!-- A plain list over the page. No filtering by context: at this length,
     deciding which half to hide is more apparatus than the list is. -->
{#if keysOpen}
  <div
    class="sheetback"
    role="button"
    tabindex="-1"
    aria-label="Close"
    onclick={() => (keysOpen = false)}
    onkeydown={(e) => e.key === "Enter" && (keysOpen = false)}
  ></div>
  <div class="sheet" role="dialog" aria-label="Keyboard and mouse">
    <h2>Keyboard and mouse</h2>
    <dl>
      <!-- Unkeyed on purpose. The list is a constant, so a key buys nothing —
           and keying it by the shortcut made two rows that answer to Escape a
           duplicate key, which throws and takes the sheet with it. -->
      {#each KEYS as [keys, what]}
        <dt>{keys}</dt>
        <dd>{what}</dd>
      {/each}
    </dl>
    <!-- The version, and the only place it is written down. This sheet is the
         nearest thing the app has to an About box, and a number nobody can read
         off the screen is a number nobody can put in a bug report. -->
    <p class="build">
      Tessera {version}
      {#if newer}
        · <button class="link" onclick={openRelease}>{newer} is out — release notes</button>
      {/if}
      {#if linkFailed}
        <span class="failed">{linkFailed}</span>
      {/if}
    </p>
    <button onclick={() => (keysOpen = false)}>Close</button>
  </div>
{/if}

<!-- The class icons, as a grid of the artwork itself: at 32 classes a list of
     names is a reading exercise, and the shape is what anyone recognises. The
     artwork is white, so each sits on its own lighter tile — on the sheet's own
     background a white icon on nothing is a white icon on black. -->
{#if iconsOpen}
  <div
    class="sheetback"
    role="button"
    tabindex="-1"
    aria-label="Close"
    onclick={closeIconSheet}
    onkeydown={(e) => e.key === "Enter" && closeIconSheet()}
  ></div>
  <div class="sheet" role="dialog" aria-label="Class icons">
    <h2>{iconHeading()}</h2>
    <!-- Thirty-three silhouettes, and the one being replaced is somewhere among
         them. Typing narrows; the class in force is outlined, the same way the
         picture gallery marks the picture in force. -->
    <input class="filter" placeholder="Filter…" bind:value={iconFilter} />
    <div class="icongrid">
      {#each ICON_NAMES.filter( (n) => n.toLowerCase().includes(iconFilter.trim().toLowerCase()), ) as name (name)}
        <button
          class:on={name === iconInForce()}
          title={name}
          onclick={() => {
            const target = iconTarget;
            closeIconSheet();
            if (target?.tile) void setTileAsset(target.tile, target.layer, name);
            else if (target) void setLayerField(target.layer, "icon", name);
            // Nothing asked for it: the toolbar did, so it lands wherever a new
            // layer lands — the sheet, or every picked tile.
            else addShape("icon", name);
          }}
        >
          <!-- Drawn from the same parsed paths the layer is drawn from, so the
               preview cannot drift from the thing it previews — and with a
               viewBox this time. All but one of the files carry a pixel size
               and no viewBox, which is a drawing that does not scale: the tile
               then shows the empty top-left corner of a 1024px square. -->
          {#if iconArt(name)}
            {@const art = iconArt(name)!}
            <svg class="art" viewBox="0 0 {art.w} {art.h}" aria-hidden="true">
              {#each art.paths as p, i (i)}
                <path d={p.d} fill="#ffffff" fill-opacity={p.opacity} fill-rule="evenodd" />
              {/each}
            </svg>
          {/if}
          <span class="name">{name}</span>
        </button>
      {/each}
    </div>
    <button onclick={closeIconSheet}>Close</button>
  </div>
{/if}

<style>
  :global(body) {
    margin: 0;
    background: #0e0b16;
    color: #d9d4e8;
    font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
    /* The parts of the interface the browser draws itself, not us: the colour
       picker's own window, scrollbars, the caret. Without this they are drawn
       for a white page and arrive white in the middle of a dark one. The
       property inherits, so declaring it here covers every control. */
    color-scheme: dark;
  }

  /* Nothing styled focus, so keyboard users got the browser's own ring: amber,
     hard against the element, on a dark surface accented in cyan. This is the
     app's accent with an offset, so it reads as part of the interface and can
     be seen in a list of 32px rows. `:focus-visible`, so a mouse click does
     not leave a ring behind on every button it touches. */
  :global(:focus-visible) {
    outline: 2px solid #a685ff;
    outline-offset: 1px;
  }

  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .stage {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  /* While a shelved tile is being carried, so the wall reads as a target
     rather than as scenery the drag happens to be over. */
  .stage.dropping {
    outline: 2px dashed #a685ff;
    outline-offset: -4px;
  }

  .home {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 24px;
  }

  .cards {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 16px;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    width: 210px;
    padding: 12px;
    text-align: left;
  }

  .card:hover {
    border-color: #a685ff;
  }

  /* The inbox is where a newly created character turns up, so it leads and
     says so — the projects are arrangements, this one is a to-do. */
  .card.inbox {
    border-color: #4a3a78;
    background: #17122b;
  }

  .cardname {
    font-size: 14px;
    color: #e3dbff;
  }

  .cardsub {
    color: #8f88a8;
    font-size: 11px;
  }

  .strip {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-top: 6px;
  }

  .more {
    color: #6f688a;
    font-size: 11px;
  }

  /* An edit that has been taken back. Still listed, still clickable — it is
     the only place that says what a redo would put back — but plainly not in
     force, the same grey the app already uses for a hidden layer. */
  .step.undone .name {
    color: #6f688a;
    font-style: italic;
  }

  /* Where you are standing, drawn on the newest edit still in force. A line
     above it rather than a row of its own: a row can be clicked, and there is
     no state to travel to at "now". */
  .step.now {
    border-top: 1px solid #a685ff;
  }

  .shelfrow {
    cursor: grab;
  }

  /* Amber, not the app's blue: this is the one thing on the page that wants an
     answer before anything else is worth doing. */
  .alert {
    max-width: 640px;
    margin-bottom: 16px;
    padding: 12px;
    border: 1px solid #6b5320;
    border-radius: 4px;
    background: #1e1a10;
  }

  .alerthead {
    margin: 0 0 4px;
    color: #ffc45c;
  }

  .alert ul {
    margin-top: 8px;
  }

  /* The two mass answers, shoulder to shoulder above the per-tile list. */
  .alert .row {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }

  .badge {
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 8px;
    background: #3a2b5e;
    color: #e3dbff;
    font-size: 10px;
  }

  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid #241e3a;
  }

  .sheetback {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: rgb(0 0 0 / 0.5);
    border: 0;
  }

  .sheet {
    position: fixed;
    z-index: 31;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    max-height: 80vh;
    overflow: auto;
    padding: 18px 22px;
    border: 1px solid #3a444c;
    border-radius: 8px;
    background: #17122b;
    box-shadow: 0 10px 40px rgb(0 0 0 / 0.5);
  }

  /* Six across fits the 32 classes in six rows without a scroll on a 1280
     window, and 72px leaves the thinner icons — a bow, a pair of daggers —
     readable rather than merely present. */
  .icongrid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 8px;
    margin-bottom: 14px;
  }

  .icongrid button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 4px;
    background: #241d3f;
  }

  .icongrid button:hover {
    background: #2f2652;
  }

  /* The class in force, marked the way the picture gallery marks the picture in
     force — the same sign for the same fact. */
  .icongrid button.on {
    border-color: #a685ff;
    box-shadow: inset 0 0 0 1px #a685ff;
  }

  .sheet .filter {
    width: 100%;
    margin-bottom: 8px;
  }

  .icongrid .art {
    display: block;
    width: 72px;
    height: 72px;
  }

  .icongrid .name {
    font-size: 11px;
    color: #b9b2d4;
  }

  .sheet h2 {
    margin: 0 0 12px;
  }

  .sheet dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 18px;
    margin: 0 0 14px;
  }

  .sheet dt {
    color: #e3dbff;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    white-space: nowrap;
  }

  .sheet dd {
    margin: 0;
    color: #8f88a8;
    font-size: 12px;
  }

  .status {
    margin-left: auto;
    color: #8f88a8;
  }

  .docs {
    display: flex;
    gap: 2px;
    margin-right: 6px;
    padding-right: 8px;
    border-right: 1px solid #241e3a;
  }

  .tools {
    flex: none;
    display: grid;
    grid-template-columns: repeat(2, 38px);
    gap: 3px;
    align-content: start;
    padding: 8px;
    border-right: 1px solid #241e3a;
    overflow-y: auto;
  }

  .tools button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 32px;
    padding: 0;
    font: 15px/1 ui-sans-serif, system-ui, sans-serif;
    color: #d9d4e8;
  }

  /* Same fade as every other disabled control — three different values across
     two files made "unavailable" look like three different states. */
  .tools button:disabled {
    opacity: 0.45;
  }

  /* Every button says so under the pointer. Most did not: the rail, the header
     and the sidebar each styled their own and the rest stayed flat, so half the
     controls in this app gave no sign they were controls at all. One rule,
     global on purpose — a per-list rule is what produced the gaps. Anything
     with a hover of its own is more specific and still wins. */
  :global(button:not(:disabled):hover) {
    background: #2f2652;
  }

  .tools .gap {
    grid-column: 1 / -1;
    height: 6px;
  }

  /* A mode reads as pressed, not as hovered: filled, outlined in the accent,
     and it stays that way with the pointer somewhere else entirely. The tool
     buttons beside it do something and are done; this one is a state. */
  .tools button.mode.on {
    background: #3a2f68;
    border-color: #a685ff;
    box-shadow: inset 0 0 0 1px #a685ff;
    color: #efeaff;
  }

  /* A glyph, not a word: it sits inside the document group but is not a
     document, and the tabs beside it are the ones that should carry the reading
     weight. Same height as those tabs so the row keeps one baseline. */
  .reload {
    margin-left: 4px;
    padding: 4px 8px;
    font: 14px/1 ui-sans-serif, system-ui, sans-serif;
    color: #8f88a8;
  }

  .docs button.active {
    border-color: #a685ff;
    background: #2a2244;
    color: #e3dbff;
  }

  .link {
    padding: 0 4px;
    border-color: transparent;
    background: none;
    color: #a685ff;
    text-decoration: underline;
  }

  /* On its own line under the link: the URL is in it, and wrapping it into the
     version line would push the version out of sight. */
  .failed {
    display: block;
    margin-top: 4px;
    color: #ff8a8a;
    overflow-wrap: anywhere;
  }

  aside {
    position: relative;
    width: 300px;
    flex: none;
    overflow-y: auto;
    padding: 8px;
    border-left: 1px solid #241e3a;
  }

  /* The browser's own scrollbar is a bright slab in a dark app. Chromium draws
     this one, and Chromium is the only engine this ships on. */
  aside::-webkit-scrollbar,
  .stage ::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }

  aside::-webkit-scrollbar-track,
  .stage ::-webkit-scrollbar-track {
    background: transparent;
  }

  aside::-webkit-scrollbar-thumb,
  .stage ::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 6px;
    background: #322a4c;
    background-clip: content-box;
  }

  aside::-webkit-scrollbar-thumb:hover,
  .stage ::-webkit-scrollbar-thumb:hover {
    background: #453a66;
    background-clip: content-box;
  }

  .totop {
    position: sticky;
    bottom: 4px;
    left: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid #3a444c;
    border-radius: 13px;
    background: #1d1832;
    color: #8f88a8;
    cursor: pointer;
  }

  .totop:hover {
    color: #e2dded;
  }

  /* The header's copy has to match the tab it stands in for, not the sidebar
     rows the rule above is cut for. Measured: a tab is 28.19px tall and that
     32px + 2px of border is 34, so renaming a Layout grew the whole top row by
     the difference and everything below it jumped. Same padding and border
     width as `button`, so the two are the same height by construction. */
  .docs .rename {
    flex: none;
    width: 150px;
    height: auto;
    padding: 4px 10px;
  }

  /* On the "?" button, over its top right corner. Positioned against the
     button rather than sitting in its text, so the glyph stays centred and the
     mark reads as a badge on the control instead of punctuation after it.
     `.help` and not `.reload`: two buttons in this header wear that class, and
     the other one is the refresh beside it. */
  .reload.help {
    position: relative;
  }

  .fresh {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ff4d4d;
  }

  /* The version line: quiet, and the same grey every other aside in this app
     is set in. */
  .build {
    margin: 10px 0 0;
    color: #8f88a8;
    font-size: 11px;
  }

  .build .link {
    padding: 0;
    border: 0;
    background: none;
    color: #cbb8ff;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
