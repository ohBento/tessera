<script lang="ts">
  /* Bare shell, still. Two documents live here — the wall and one open Layout —
   * and which is showing decides both the canvas in the middle and what the
   * side panel lists. The tool strip and dense token set land in M4; this
   * exists to drive the layout/stamp path end to end. */
  import { onMount, tick } from "svelte";
  import { ask } from "./lib/platform";

  import ContextMenu, { type Item } from "./ContextMenu.svelte";
  import GridCanvas from "./GridCanvas.svelte";
  import LayoutCanvas from "./LayoutCanvas.svelte";
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
    deleteLayoutDoc,
    deleteLayoutLayer,
  deleteLayoutLayers,
    deleteProject,
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
    layoutUsage,
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
    redoable,
    releaseTilesToInbox,
    remainingFor,
    replaceAllCharacters,
    replaceCharacter,
    renameLayer,
    renameLayout,
    renameFolder,
    renameProject,
    restorableCount,
    restoreProject,
    removeFolder,
    removeSnapshot,
    renameSnapshot,
    restoreSnapshot,
    saveLayout,
    saveToGame,
    selectLayer,
    selectLayoutLayer,
    strippableCount,
    stripSelectedTiles,
    setTileText,
    pickTileImage,
    setLayerField,
    setTileAsset,
    tileAsset,
    tileCaptions,
    tileImageChoices,
    tileFrame,
    tileIcons,
    tileImages,
    tileLayers,
    shelfIds,
    snapshots,
    takeSnapshot,
    tileProject,
    unplace,
    tileText,
    visibleIds,
    toggleLayerHidden,
    toggleLayerLocked,
    toggleLayoutLayerHidden,
    toggleLayoutPick,
    toggleTile,
    undoEdit,
    undoable,
  } from "./lib/editor.svelte";
  import { isTyping } from "./lib/geometry";
  import { ICON_NAMES, iconArt } from "./lib/icons";
  import { savePending } from "./lib/project";
  import { findLayer, isLiveCopy, layerLabel, layoutNeedsRestamp, type Layer } from "./lib/model";

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

  /** What the sheet lists. Written out rather than derived from the handler:
   *  half of these are canvas gestures that no handler declares, and a list
   *  that could drift is still better than a list nobody can find. */
  const KEYS: Array<[string, string]> = [
    ["Ctrl + Z", "Undo"],
    ["Ctrl + Y  ·  Ctrl + Shift + Z", "Redo"],
    ["Ctrl + D", "Duplicate the picked layers (in a Layout)"],
    ["Delete  ·  Backspace", "Delete the picked layers (in a Layout)"],
    ["Escape", "Leave the framing tool"],
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
  /* Projects starts open: it is the way into a wall, and a first run that
     shows a collapsed heading and nothing else looks like an app that failed
     to load its folder. Everything else earns its twisty by being long. */
  let open = $state(new Set<string>(["projects"]));
  const toggleOpen = (id: string) => {
    open.has(id) ? open.delete(id) : open.add(id);
    open = new Set(open);
  };
  /* Whatever was just made has to be visible. Projects and Layouts are hidden
     with CSS rather than dropped from the markup, so their "+" sits outside the
     hidden list and stays pressable while the section is shut — and the new row
     landed somewhere the eye could not follow. Snapshots and Folders drop their
     whole block, "+" included, so this does not arise there. */
  const reveal = (id: string) => {
    open.add(id);
    open = new Set(open);
  };

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
    const path = drawer ? ["groups", drawer.id] : ["tiles"];
    if (path.some((key) => !open.has(key))) {
      for (const key of path) open.add(key);
      open = new Set(open);
    }
    if (picked.length === 1 && !open.has(picked[0])) toggleTileRow(picked[0]);
    // After the row exists, not before — opening it is what creates it.
    void tick().then(() =>
      document.querySelector(`[data-tile="${first}"]`)?.scrollIntoView({ block: "nearest" }),
    );
  });

  /** Opens one tile row and shuts whichever was open before.
   *
   *  An accordion only for tile rows — drawers and the section heads share the
   *  same set and stay independent of each other. A row carries the wording
   *  fields and the picture gallery now, so two of them open at once is a list
   *  you have to scroll past to reach the next id. */
  function toggleTileRow(id: string) {
    const wasOpen = open.has(id);
    for (const tile of visibleIds()) open.delete(tile);
    if (!wasOpen) open.add(id);
    open = new Set(open);
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

    void draw(arg);
    return {
      update: (next: { id: string; ready: boolean }) => void draw(next),
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

  /** The Layout canvas — the toolbar's align buttons act on its live objects. */
  let sheet: LayoutCanvas | undefined = $state();
  const noPick = $derived(!editing || !app.layoutSelection.length);
  const fewPicked = $derived(!editing || app.layoutSelection.length < 3);

  /* --- Dragging rows to reorder. Native HTML drag-and-drop rather than
     pointer bookkeeping: it is what the browser already knows how to do, and
     Tauri's own OS-level file drop is switched off (tauri.conf.json) precisely
     so this keeps working.

     A row is a source, and it is a target in three places: the top third
     drops in front of it, the bottom third behind it, and — on a group — the
     middle third drops inside. That is the whole vocabulary; anything more
     needs a mode. --- */

  type Where = "before" | "after" | "into";
  let dragId = $state("");
  let dropOn = $state<{ id: string; where: Where } | null>(null);

  /** The shelved tile being carried onto the wall, "" for none. Separate from
   *  `dragId`, which carries layer rows: the two land in different places and
   *  sharing one field would let a layer drop reorder the grid. */
  let dragTile = $state("");

  /** Which third of the row the pointer is in. "into" only where it means
   *  something, so a plain row never offers a target that cannot take it. */
  function zone(e: DragEvent, canHold: boolean): Where {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const t = (e.clientY - box.top) / box.height;
    if (canHold && t > 0.3 && t < 0.7) return "into";
    return t < 0.5 ? "before" : "after";
  }

  const startDrag = (e: DragEvent, id: string) => {
    dragId = id;
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  };

  function over(e: DragEvent, id: string, canHold: boolean) {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    const where = zone(e, canHold);
    if (dropOn?.id !== id || dropOn.where !== where) dropOn = { id, where };
  }

  const endDrag = () => {
    dragId = "";
    dropOn = null;
  };

  /** Where a drop lands, expressed as the model wants it: the row to go in
   *  front of, and the group to go inside. `after` becomes "in front of the
   *  next sibling", or the end of the list. */
  function landing(rows: Layer[], id: string, where: Where, parentId: string | null) {
    if (where === "into") return { parentId: id, beforeId: null };
    /* `rows` is drawn topmost-first; the model stores bottom-first, so the two
     * run in opposite directions. Dropping *above* a row means landing after
     * it in the model — which is "in front of" whatever the row above it is,
     * or the end of the list when there is nothing above. Dropping *below* it
     * means landing in front of that row itself. */
    const at = rows.findIndex((l) => l.id === id);
    // The list the anchor lives in is where the layer lands, so a drop between
    // two children stays inside their group instead of escaping to the top.
    return { parentId, beforeId: where === "before" ? (rows[at - 1]?.id ?? null) : id };
  }

  /** Autofocus drops the caret at the end of the suggested name, so the first
   *  thing typed was appended to it — "+ Snapshot" opens its field on
   *  "Snapshot 1" and a user typing a name got "Snapshot 1Before changes",
   *  which then stayed as the snapshot's name. Selecting on focus makes typing
   *  replace, the way a rename field behaves everywhere else. */
  const selectAll = (e: FocusEvent & { currentTarget: HTMLInputElement }) =>
    e.currentTarget.select();

  /* Enter and Escape both blur; Escape puts the old text back first, and the
     rename actions already ignore an unchanged name — so cancelling needs no
     flag of its own. */
  function renameKey(e: KeyboardEvent, was: string) {
    const input = e.currentTarget as HTMLInputElement;
    if (e.key === "Escape") input.value = was;
    else if (e.key !== "Enter") return;
    input.blur();
    e.stopPropagation();
  }

  /** A yes/no the user actually answered.
   *
   *  A dialog that cannot open must not read as "no". It did: the confirmation
   *  was awaited inside a condition, so a rejected ask aborted the action with
   *  no dialog, no error and no change — a button that did nothing. Cancelling
   *  is still the safe answer when it fails, but now it says so. */
  async function confirmed(message: string, title: string) {
    try {
      return await ask(message, { title, kind: "warning" });
    } catch (e) {
      app.error = `Could not ask for confirmation: ${e}`;
      return false;
    }
  }

  /** Deleting a Layout takes its stamps and live captions off every tile with
   *  it — a layout and its layers on the wall do not survive each other. One
   *  undo step brings the lot back, but it is still a wall-wide change, which
   *  is worth saying out loud first. */
  async function removeLayout(id: string, name: string) {
    const used = layoutUsage(id);
    /* Asked either way. An unstamped Layout is not a cheap thing — it is a
       design somebody built and has not put on a wall yet — and it was one
       click from gone while a stamped one got a dialog. */
    const message = used
      ? // Both units again: the deletion is counted per stamp, but what it is
        // visible on is tiles.
        `"${name}" is stamped ${used} time(s), on ${layoutTiles(id)} tile(s). ` +
        `Deleting it removes those stamps from the tiles too.`
      : `Delete the layout "${name}"? It is not on any tile yet.`;
    if (!(await confirmed(message, "Delete layout?"))) return;
    await deleteLayoutDoc(id);
  }

  /** Puts the game's own portraits back over this project's tiles.
   *
   *  Asks first even though nothing in the document changes: it is the one
   *  action here that reaches into the game folder without being reversible by
   *  Ctrl+Z, and the way back is a second deliberate press of Write to game. */
  async function resetProject() {
    const p = openProject();
    if (!p) return;
    if (
      !(await confirmed(
        `Put the game's original portraits back for ${restorableCount()} tile(s) of "${p.name}"? ` +
          `Your layers and arrangement stay — press Write to game to put them back on.`,
        "Reset in game?",
      ))
    )
      return;
    await restoreProject();
  }

  /** The button that reaches out of the app and overwrites the game's own
   *  files. It asked nothing, while "Reset in game" beside it — fully
   *  reversible by pressing this one — asked every time. The question belongs
   *  on the side that leaves the folder changed. */
  async function writeToGame() {
    const p = openProject();
    if (!p) return;
    if (
      !(await confirmed(
        `Write ${p.order.length} tile(s) of "${p.name}" over the game's portrait files? ` +
          `The originals are kept, and "Reset in game" puts them back.`,
        "Write to game?",
      ))
    )
      return;
    await saveToGame();
  }

  /** The whole list answered at once, and the one answer with a step Ctrl+Z
   *  cannot take back: a new character means the game's original for that slot
   *  is a stranger's face, so the vault copy is deleted. After this there is no
   *  "Reset in game" for those tiles, and the question does not come round
   *  again — the entry leaves the list either way. */
  async function allNewCharacters() {
    const n = app.changedTiles.length;
    if (
      !(await confirmed(
        `Treat all ${n} portrait(s) as new characters? Their layers and wording go, ` +
          `they return to Unsorted, and the vaulted originals are deleted — ` +
          `"Reset in game" cannot bring those back.`,
        "All new characters?",
      ))
    )
      return;
    await replaceAllCharacters();
  }

  /** Undressing a wall is the bluntest thing on this menu: layers, hand-typed
   *  wording and per-tile pictures, on as many tiles as are picked. Deleting one
   *  Layout asks first; taking everything off forty-four portraits did not.
   *  Ctrl+Z holds it for the session, which is why one question is enough. */
  async function clearLayers() {
    const n = strippableCount();
    if (
      !(await confirmed(
        `Take everything off ${n} tile(s)? Layers, the wording typed on them and ` +
          `the pictures chosen per tile all go. Ctrl+Z brings them back.`,
        n > 1 ? "Clear all layers?" : "Clear the layers?",
      ))
    )
      return;
    await stripSelectedTiles();
  }

  /** Restoring replaces more than the arrangement, and the tooltip said only
   *  what it does *not* touch. A project snapshot puts back the whole project
   *  record — its name, its drawers, its wall picture — so a rename and a
   *  folder made after the snapshot were gone with one unasked click. Ctrl+Z
   *  does take it back, which is why one question is enough. */
  async function putBack(snap: { name: string; projectId: string }) {
    const what = snap.projectId
      ? `this wall's name, arrangement, folders, wall picture and the layers on its tiles`
      : `every project, layout and tile in the document`;
    if (
      !(await confirmed(
        `Put "${snap.name}" back? That replaces ${what} with the state it had when ` +
          `the snapshot was taken. Ctrl+Z undoes it; the game folder is not touched.`,
        "Restore snapshot?",
      ))
    )
      return;
    await restoreSnapshot(snap);
  }

  /** A snapshot is the only thing in this sidebar that Ctrl+Z cannot bring
   *  back, and its × sits beside the ↺ that restores it. Worth one question. */
  async function dropSnapshot(snap: { name: string; projectId: string }) {
    if (
      !(await confirmed(
        `Delete the snapshot "${snap.name}"? There is no undo for this one.`,
        "Delete snapshot?",
      ))
    )
      return;
    await removeSnapshot(snap);
  }

  /** Two questions, on purpose. The first is the safety net on the delete
   *  itself; the second decides what the tiles take with them to Unsorted —
   *  keep their artwork, or arrive bare. Native ask() only knows yes/no, so the
   *  three-way choice is two dialogs in a row. */
  async function removeProject(id: string, name: string) {
    const p = projects().find((x) => x.id === id);
    if (!p) return;
    const owned = p.order.length + p.shelf.length;
    if (
      !(await confirmed(
        `Delete "${name}"? Its ${owned} tile(s) go back to Unsorted; ` +
          `the arrangement is what you lose` +
          /* The tiles survive, the project record does not — and its drawers
             and its wall-wide picture live in that record. The dialog counted
             only the tiles, so both went unmentioned. */
          (p.folders.length ? `, along with ${p.folders.length} folder(s)` : "") +
          (p.gridLayers.length ? ` and the picture across the wall` : "") +
          `.`,
        "Delete project?",
      ))
    )
      return;
    const dressed = [...p.order, ...p.shelf].filter(
      (t) => app.manifest.tiles[t]?.layers.length,
    ).length;
    const strip =
      !!dressed &&
      (await confirmed(
        `Also remove all layers from its ${dressed} tile(s)? ` +
          `"No" keeps the artwork on them.`,
        "Remove layers too?",
      ));
    await deleteProject(id, strip);
  }

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
        ...(layouts().length
          ? [
              { separator: true } as Item,
              ...layouts().map((l) => ({
                label:
                  picked === 1 ? `Assign "${l.name}"` : `Assign "${l.name}" to ${picked} tiles`,
                run: () => void assignLayoutToSelection(l.id),
              })),
              /* And the whole wall in one item, for the case the selection
                 exists to serve: a second account's forty-four portraits, all
                 wanting the same design. Counted as work left to do — a tile
                 already wearing it is not offered a second stamp — so the
                 number vanishes to nothing once the wall is dressed. */
              ...layouts()
                .filter((l) => remainingFor(l.id).length)
                .map((l) => ({
                  label: `Assign "${l.name}" to all ${remainingFor(l.id).length} remaining`,
                  run: () => void assignLayoutToWall(l.id),
                })),
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
        class:drop-before={dropOn?.id === layer.id && dropOn.where === "before"}
        class:drop-after={dropOn?.id === layer.id && dropOn.where === "after"}
        class:drop-into={dropOn?.id === layer.id && dropOn.where === "into"}
        draggable="true"
        ondragstart={(e) => startDrag(e, layer.id)}
        ondragover={(e) => over(e, layer.id, layer.kind === "group")}
        ondragleave={() => dropOn?.id === layer.id && (dropOn = null)}
        ondragend={endDrag}
        ondrop={(e) => {
          e.preventDefault();
          const spot = dropOn;
          const moving = dragId;
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
          {@render eyeIcon(!!layer.hidden)}
        </button>
        <button
          class="eye"
          class:on={layer.locked}
          title={layer.locked ? "Unlock" : "Lock"}
          onclick={() => toggleLayerLocked(layer.id)}
        >
          {@render lockIcon(!!layer.locked)}
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

<!-- Monochrome and drawn here, not typed as emoji. An emoji is rendered by the
     system font in its own colours, which fights every theme it lands in and
     changes shape between machines. These take currentColor and stay put. -->
{#snippet eyeIcon(hidden: boolean)}
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M1 7c1.8-2.7 3.8-4 6-4s4.2 1.3 6 4c-1.8 2.7-3.8 4-6 4s-4.2-1.3-6-4z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
    />
    {#if hidden}
      <line x1="2.5" y1="11.5" x2="11.5" y2="2.5" stroke="currentColor" stroke-width="1.2" />
    {:else}
      <circle cx="7" cy="7" r="1.9" fill="currentColor" />
    {/if}
  </svg>
{/snippet}

{#snippet lockIcon(locked: boolean)}
  <!-- Three differences at once, because one was not enough to read at a
       glance: the shackle closes, the body fills, and the button takes the
       accent colour. The old icon changed only by whether a 1.6px leg reached
       the body, which at 14px is a hairline nobody can see. -->
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d={locked ? "M5.4 7.4V5.4a2.6 2.6 0 0 1 5.2 0v2" : "M5.4 7.4V5a2.6 2.6 0 0 1 5.2 0v0.6"}
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
      fill={locked ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width="1.5"
    />
  </svg>
{/snippet}

<!-- The stamps on one holder — a group's stack or a single tile's own. Same
     row either way, so `drop` is the only thing that differs: which list the
     reorder writes back to. -->
{#snippet stampRows(rows: Layer[], drop: (moving: string, beforeId: string | null) => void)}
  <ul class="indent">
    {#each rows as layer (layer.id)}
      <li
        class:selected={app.selected === layer.id}
        aria-current={app.selected === layer.id ? "true" : undefined}
        class:drop-before={dropOn?.id === layer.id && dropOn.where === "before"}
        class:drop-after={dropOn?.id === layer.id && dropOn.where === "after"}
        draggable="true"
        ondragstart={(e) => startDrag(e, layer.id)}
        ondragover={(e) => over(e, layer.id, false)}
        ondragleave={() => dropOn?.id === layer.id && (dropOn = null)}
        ondragend={endDrag}
        ondrop={(e) => {
          e.preventDefault();
          const spot = dropOn;
          const moving = dragId;
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
          {@render eyeIcon(!!layer.hidden)}
        </button>
        <button
          class="eye"
          class:on={layer.locked}
          title={layer.locked ? "Unlock" : "Lock"}
          onclick={() => toggleLayerLocked(layer.id)}
        >
          {@render lockIcon(!!layer.locked)}
        </button>
        <button
          class="name"
          class:dimmed={layer.hidden}
          onclick={() => selectLayer(layer.id)}
          ondblclick={() => layer.layoutId && openLayoutDoc(layer.layoutId)}
          title={layer.layoutId ? "Double-click opens the layout" : "Select this layer"}
        >
<!-- Marker before the name, not after: the name is what gets
               ellipsised when the row runs out of width, and a dot hidden
               behind "…" is the same as no dot at all. -->{#if stampDirty(layer)}<span
              class="dirty"
              title="Layout changed — press Update stamps">●&nbsp;</span
            >{/if}{stampName(layer)}
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
{#snippet tileRow(id: string, inGroup: string)}
  {@const own = stampsOf(tileLayers(id))}
  {@const owner = tileProject(id)}
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
        {open.has(id) ? "▾" : "▸"}
      </button>
      <!-- The face, not the number. "40000000005773694" identifies a file and
           nobody else; at sixty-eight portraits the list was a column of digits
           to be matched against the wall by counting. The game's own picture,
           deliberately, even where a mosaic is baked over the tile: this
           answers "who is this", and a slice of some wall-wide image answers it
           for nobody. -->
      <canvas class="thumb" width="31" height="40" use:portrait={{ id, ready: !!app.deps }}
      ></canvas>
      <button
        class="name"
        onclick={(e) => toggleTile(id, { ctrl: e.ctrlKey, shift: e.shiftKey })}
        title="Picks this tile on the wall · Ctrl adds one, Shift takes the range"
      >
        {id}
        <span class="usage">
          {own.length ? `${own.length} layout(s)` : owner ? "no layout" : "unassigned"}
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

    {#if open.has(id)}
      {@render stampRows(
        own,
        (moving, beforeId) => void dropTileLayer(id, moving, beforeId),
      )}
      <select
        class="indent assign"
        disabled={!layouts().length || !!app.busy}
        onchange={(e) => {
          const layoutId = e.currentTarget.value;
          e.currentTarget.value = "";
          if (layoutId) void assignTileLayout(id, layoutId);
        }}
      >
        <option value="">+ Assign layout…</option>
        {#each layouts() as layout (layout.id)}
          <option value={layout.id}>{layout.name}</option>
        {/each}
      </select>

      <!-- What this tile alone says and shows. In the row rather
           than in a panel below the list: with forty-four rows,
           editing the first one meant scrolling past all of them
           and back. Here the fields cannot be further away than
           the row they belong to. -->
      {#each tileCaptions(id) as caption (caption.id)}
        <label class="field indent">
          <span>{layerLabel(caption)}</span>
          <!-- The default shows as a placeholder, not as a value:
               typing over a real value and clearing a field look
               identical, and only one of them should mean "this
               tile says nothing". -->
          <input
            value={tileText(id, caption.id) ?? ""}
            placeholder={caption.text}
            oninput={(e) => void setTileText(id, caption.id, e.currentTarget.value)}
          />
          <button
            title="Use the layer's default text again"
            disabled={tileText(id, caption.id) === undefined}
            onclick={() => void clearTileText(id, caption.id)}>↺</button
          >
        </label>
      {/each}

      {#each tileImages(id) as pic (pic.id)}
        {@const chosen = tileAsset(id, pic.id)}
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
              class:on={(chosen ?? pic.asset) === asset}
              title={asset === pic.asset
                ? "The layer's own picture"
                : "Use this picture"}
              onclick={() => void setTileAsset(id, pic.id, asset)}
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
            class:on={chosen === ""}
            title="Show no picture on this tile"
            onclick={() => void setTileAsset(id, pic.id, "")}
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
          <button
            class="swatch"
            title="Use the layer's own picture again"
            disabled={chosen === undefined}
            onclick={() => void clearTileAsset(id, pic.id)}>↺</button
          >
          <!-- The way back from a framing that went wrong. No numbers beside
               it: the frame on the wall is where framing is done, and a row of
               fields here would ask why moving has them and everything else
               does not. -->
          <button
            class="swatch"
            title="Show this picture where the Layout put it"
            disabled={!tileFrame(id, pic.id)}
            onclick={() => void clearTileFrame(id, pic.id)}>⤢</button
          >
        </div>
      {/each}

      <!-- Which class this portrait is. The same map as the pictures above and
           the same bargain — the Layout placed and coloured the icon once, the
           tile names the class — but the choices need no importing, so it is
           the artwork grid rather than a gallery of what happens to be in
           play. -->
      {#each tileIcons(id) as badge (badge.id)}
        {@const chosen = tileAsset(id, badge.id)}
        {@const showing = chosen ?? badge.icon}
        <!-- "Class", not the layer's name. An icon layer is auto-named after
             the class it was made with — Witch01 — so the layer's name over a
             tile showing Ranger asserted a class the tile does not have, forty
             times down the list. The name is still reachable in the Layout;
             here the question is which class this portrait is. -->
        <p class="sub">Class</p>
        <div class="gallery indent">
          <button
            class="swatch art"
            title={chosen
              ? `${chosen} — pick another class`
              : showing
                ? `${showing}, from the layer — pick a class for this tile`
                : "Pick a class"}
            onclick={() => {
              iconTarget = { tile: id, layer: badge.id };
              iconsOpen = true;
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
            class:on={chosen === ""}
            title="Show no icon on this tile"
            onclick={() => void setTileAsset(id, badge.id, "")}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" stroke-width="1.6" />
              <line x1="4" y1="14" x2="14" y2="4" stroke="currentColor" stroke-width="1.6" />
            </svg>
          </button>
          <button
            class="swatch"
            title="Use the layer's own class again"
            disabled={chosen === undefined}
            onclick={() => void clearTileAsset(id, badge.id)}>↺</button
          >
        </div>
      {/each}
    {/if}
  </div>
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
      {#if editing}
        {#if renaming === editing.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="rename"
            autofocus
            onfocus={selectAll}
            value={editing.name}
            onblur={(e) => {
              void renameLayout(editing.id, e.currentTarget.value);
              renaming = "";
            }}
            onkeydown={(e) => renameKey(e, editing.name)}
          />
        {:else}
          <!-- Double-click renames, the same gesture as in the layout list and
               on a group row. The name is right here while you work on the
               document; going back to the list to change it is a trip. -->
          <button
            class="active"
            title="Esc closes · double-click renames"
            ondblclick={() => (renaming = editing.id)}>{editing.name}</button
          >
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
        class="reload"
        onclick={() => (keysOpen = true)}
        title="Keyboard and mouse (?)"
        aria-label="Keyboard and mouse shortcuts"
      >
        ?
      </button>
    </div>

    {#if editing}
      <button
        class="primary"
        onclick={() => saveLayout(editing.id)}
        disabled={!canSaveLayout(editing.id) || !!app.busy}
        title={layoutUsage(editing.id)
          ? `Applies the changes to ${layoutUsage(editing.id)} stamp(s)`
          : "Not stamped anywhere yet"}
      >
        <!-- Not "Save": the Layout is written to disk on every edit, so a
             save button would promise something that already happened. What
             this does is re-render and swap the picture in every stamp. -->
        Update stamps{#if layoutUsage(editing.id)}&nbsp;({layoutUsage(editing.id)}){/if}
      </button>
    {:else}
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
    {/if}

    <span class="status">
      {#if app.busy}
        {app.busy}…
      {:else if app.error}
        {app.error}
      {:else if editing && canSaveLayout(editing.id)}
        Saved &middot; changes not on the tiles yet
      {:else if editing}
        Saved
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
      {@render tool("Undo (Ctrl+Z)", "↶", () => void undoEdit(), !undoable())}
      {@render tool("Redo (Ctrl+Y)", "↷", () => void redoEdit(), !redoable())}
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
          ? "Framing a tile's picture: drag to move it, corners zoom, the top handle turns. Escape leaves"
          : "Frame a tile's picture inside its mask"}
      >
        <svg width="17" height="17" viewBox="0 0 17 17" aria-hidden="true">
          <path d="M4.5 1 V12.5 H16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          <path d="M1 4.5 H12.5 V16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          <path d="M6.5 10.5 L8.8 7.6 L10.4 9.4 L12 7.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" opacity="0.8" />
        </svg>
      </button>
      <span class="gap"></span>
      <!-- Framed mountain and sun, the icon every editor uses for a picture —
           no Unicode glyph reads as one at this size. -->
      <button title="Insert image — opens a file picker" disabled={!editing || !!app.busy} onclick={() => void addLayoutImage()}>
        <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
          <rect x="1" y="1" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <circle cx="5.4" cy="5" r="1.4" fill="currentColor" />
          <path d="M3 11.4 L7 7 L9.5 9.6 L11.5 7.6 L13.6 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
      </button>
      {@render tool("Insert text", "T", () => void addLayoutText(), !editing)}
      {@render tool("Rectangle", "▭", () => void addLayoutShape("rect"), !editing)}
      {@render tool("Ellipse", "◯", () => void addLayoutShape("ellipse"), !editing)}
      {@render tool("Polygon", "⬡", () => void addLayoutShape("polygon"), !editing)}
      <!-- The fourth shape. A picker rather than a straight insert, because
           which class it is is the whole question. -->
      {@render tool("Class icon", "✦", () => (iconsOpen = true), !editing)}
      <span class="gap"></span>
      {@render tool("Align left", "⇤", () => sheet?.alignTo("left"), noPick)}
      {@render tool("Align right", "⇥", () => sheet?.alignTo("right"), noPick)}
      {@render tool("Center horizontally", "↔", () => sheet?.alignTo("centerX"), noPick)}
      {@render tool("Center vertically", "↕", () => sheet?.alignTo("centerY"), noPick)}
      {@render tool("Align top", "⤒", () => sheet?.alignTo("top"), noPick)}
      {@render tool("Align bottom", "⤓", () => sheet?.alignTo("bottom"), noPick)}
      {@render tool("Equal horizontal gaps", "⇹", () => sheet?.spreadBy("x"), fewPicked)}
      {@render tool("Equal vertical gaps", "⇳", () => sheet?.spreadBy("y"), fewPicked)}
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
      class:dropping={!!dragTile}
      oncontextmenucapture={wallMenu}
      ondragover={(e) => dragTile && e.preventDefault()}
      ondrop={(e) => {
        e.preventDefault();
        const moving = dragTile;
        dragTile = "";
        if (moving) void placeTileAt(moving, grid?.tileAtEvent(e) || null);
      }}
    >
      {#if editing}
        <!-- The wall's faces beside the sheet, so the design can be tried on
             one. Composing against black meant stamping to find out whether a
             caption sat on a forehead; this is the same question answered
             before the stamp. Clicking a face lays it under the sheet.
             Deliberately still pictures: rendering the Layout into forty-four
             of them on every slider drag would cost more than the answer is
             worth, and the big one shows it already. -->
        {#if bedChoices().length > 1}
          <!-- A column of its own beside the tools, not a panel laid over the
               sheet: the faces are for picking from, and something that covers
               what it is meant to help with is not a help. Big enough to
               recognise a character at a glance — at thumbnail size the point
               of the strip was lost. -->
          <div class="bedcol">
            <button
              class="bedtoggle"
              title={bedStrip ? "Hide the tile strip" : "Show the tile strip"}
              onclick={() => (bedStrip = !bedStrip)}
            >
              {bedStrip ? "‹" : "›"}
            </button>
            {#if bedStrip}
              <div class="bedstrip">
                {#each bedChoices() as id (id)}
                  {@const wearing = tileLayers(id).some((l) => l.layoutId === editing.id)}
                  <button
                    class="bed"
                    class:on={bedFor(editing.id) === id}
                    class:wearing
                    title={wearing ? `${id} — already wearing this layout` : id}
                    onclick={() => setBedTile(id)}
                  >
                    <canvas
                      class="thumb"
                      width="62"
                      height="80"
                      use:portrait={{ id, ready: !!app.deps }}
                    ></canvas>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
        <LayoutCanvas bind:this={sheet} />
      {:else if home}
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
                  {@render eyeIcon(!!layer.hidden)}
                </button>
                <button
                  class="eye"
                  class:on={layer.locked}
                  title={layer.locked ? "Unlock" : "Lock"}
                  onclick={() => toggleLayerLocked(layer.id)}
                >
                  {@render lockIcon(!!layer.locked)}
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
          <button class="head" onclick={() => toggleOpen("projects")} aria-expanded={open.has("projects")}>
            <span class="twisty inline">{open.has("projects") ? "▾" : "▸"}</span>
            Projects
          </button>
        </h2>
        <ul class:collapsed={!open.has("projects")}>
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
        <button
          class="wide"
          onclick={() => {
          reveal("projects");
          void newProjectFrom("");
        }}
          disabled={!freeCount() || !!app.busy}
          title="Builds a wall from the picked tiles that no project has claimed"
        >
          + Project from selection{#if freeCount()}&nbsp;({freeCount()}){/if}
        </button>

        <!-- One library across every project: a design fits characters from
             any account, and keeping a copy per wall would mean editing the
             same frame twice. Collapsible, because that library is the list
             that grows without bound. -->
        <h2 class="spaced">
          <button class="head" onclick={() => toggleOpen("layouts")} aria-expanded={open.has("layouts")}>
            <span class="twisty inline">{open.has("layouts") ? "▾" : "▸"}</span>
            Layouts{#if layouts().length}&nbsp;({layouts().length}){/if}
          </button>
        </h2>
        {#if !layouts().length}
          <p class="empty">None yet.</p>
        {/if}
        <ul class:collapsed={!open.has("layouts")}>
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
                <!-- `inert-name`, because it is the one name button in this
                     sidebar a single click does nothing with, and it looked
                     exactly like the ones that respond. -->
                <button
                  class="name inert-name"
                  ondblclick={() => (renaming = layout.id)}
                  title={canSaveLayout(layout.id)
                    ? "Stamps are older than this Layout — open it and press Update stamps"
                    : "Double-click to rename — the pencil opens it"}
                >
                  <!-- The same dot the stamp rows carry, one level up. Those
                       are inside a tile that has to be expanded to be seen, so
                       closing a Layout after editing left the wall looking
                       finished while it was showing older art. canSaveLayout
                       already answers it; this is only where it is asked.

                       Before the name, because the name is what gets
                       ellipsised and a dot behind "…" is no dot at all. -->{#if canSaveLayout(layout.id)}<span
                      class="dirty"
                      title="Stamps are older than this Layout">●&nbsp;</span
                    >{/if}{layout.name}
                  <!-- Both numbers, because they answer different questions:
                       the stamps are what a refresh or a delete touches, the
                       tiles are how much of the wall wears the design. One
                       group of fifteen tiles used to read "stamped 1 time". -->
                  <span class="usage">
                    {layoutUsage(layout.id)
                      ? `${layoutUsage(layout.id)} stamp(s) · ${layoutTiles(layout.id)} tile(s)`
                      : "unused"}
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
        <button
          class="wide"
          onclick={() => {
            reveal("layouts");
            void newLayoutDoc(`Layout ${layouts().length + 1}`);
          }}
          disabled={!app.dir || !!app.busy}
        >
          + New layout
        </button>

        <!-- A wall put aside under a name, so it can be tried out and walked
             back from. Twenty kilobytes each — the assets and the vault copies
             a snapshot names are never deleted, so restoring one finds them all
             still there.

             The list belongs to the wall in front of you: another account's
             rollback points are not an offer worth showing here, and taking one
             by mistake would rearrange a wall you are not looking at. On the
             overview it is the document-wide ones instead. -->
        <h2 class="spaced">
          <button class="head" onclick={() => toggleOpen("snapshots")} aria-expanded={open.has("snapshots")}>
            <span class="twisty inline">{open.has("snapshots") ? "▾" : "▸"}</span>
            Snapshots{#if snapshots().length}&nbsp;({snapshots().length}){/if}
          </button>
        </h2>
        {#if open.has("snapshots")}
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
                  dragTile = id;
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                }}
                ondragend={() => (dragTile = "")}
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
             alike. Purely cosmetic — a folder renders nothing,
             owns nothing, and dissolving one leaves every tile exactly where
             it was. Its own section rather than a preamble to Tiles, because
             it is a list that grows and wants a twisty like the rest. -->
        <h2 class="spaced">
          <button class="head" onclick={() => toggleOpen("groups")} aria-expanded={open.has("groups")}>
            <span class="twisty inline">{open.has("groups") ? "▾" : "▸"}</span>
            Folders{#if folders().length}&nbsp;({folders().length}){/if}
          </button>
        </h2>
        {#if open.has("groups")}
          {#if !folders().length}
            <p class="empty">None yet.</p>
          {/if}
        {#each folders() as folder (folder.id)}
          <div
            class="group"
            role="presentation"
            onmouseenter={() => (app.hoverFolder = folder.id)}
            onmouseleave={() => (app.hoverFolder = "")}
          >
            <div class="grouphead">
              <button class="twisty" onclick={() => toggleOpen(folder.id)}>
                {open.has(folder.id) ? "▾" : "▸"}
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
            {#if open.has(folder.id)}
              <div class="indent">
                {#each folder.tiles as id (id)}
                  {@render tileRow(id, folder.id)}
                {/each}
              </div>
            {/if}
          </div>
        {/each}

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

        <h2 class="spaced">Tiles</h2>
        <div class="group">
          <div class="grouphead">
            <button class="twisty" onclick={() => toggleOpen("tiles")}>
              {open.has("tiles") ? "▾" : "▸"}
            </button>
            <button class="name" onclick={() => toggleOpen("tiles")}>
              {app.openProjectId ? "On this wall" : "Unsorted"}
              <span class="usage">{looseIds().length} · right-click the wall to assign several</span>
            </button>
          </div>

          {#if open.has("tiles")}
            <div class="indent">
              {#each looseIds() as id (id)}
                {@render tileRow(id, "")}
              {/each}
            </div>
          {/if}
        </div>

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
            else void addLayoutShape("icon", name);
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
  .thumb {
    flex: none;
    border-radius: 2px;
    background: #0e0b16;
  }
  .more {
    color: #6f688a;
    font-size: 11px;
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
  /* Hidden rather than unrendered: the list is short enough that keeping it in
     the DOM costs nothing, and the rows keep their scroll position. */
  ul.collapsed {
    display: none;
  }
  h2 .twisty.inline {
    height: auto;
    min-width: 16px;
    padding: 0;
    font-size: 11px;
    vertical-align: baseline;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid #241e3a;
  }
  button {
    font: inherit;
    padding: 4px 10px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #1d1832;
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  /* The one act per document that pushes work outward — Update stamps on a
     Layout, Write to game on the wall — wears the ramp the app is named after
     now. Everything else stays a quiet raised button, which is what keeps
     this one legible as "the" action rather than "an" action. */
  .primary {
    border-color: transparent;
    background: linear-gradient(90deg, #8f6bff, #ff5fa8);
    /* Dark ink, not the mock-up's white: white measures 3.3:1 against the
       ramp's midpoint and this is the label that must always be readable. */
    color: #140f1e;
    font-weight: 600;
  }
  /* And it gives the ramp back when it cannot be pressed. Faded to 0.45 the
     gradient was still the loudest thing on the screen, so on Home the eye
     went straight to "Write to game" — the one button there that does
     nothing. A disabled action should read as an action that is not available,
     not as the one to reach for. */
  .primary:disabled {
    border-color: #3a444c;
    background: #1d1832;
    color: inherit;
    font-weight: inherit;
  }
  /* No hand cursor on a name that only answers a double-click: the pointer is
     the promise, and here there is nothing behind a single press. */
  .inert-name {
    cursor: default;
  }
  /* Its own column in the row, so the sheet keeps the space it had — and no
     surface of its own: the tools column beside it is separated by one hairline
     and nothing else, and a second shade here would invent a panel the app does
     not otherwise have. */
  .bedcol {
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: stretch;
    min-height: 0;
    border-right: 1px solid #241e3a;
  }
  .bedstrip {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
    overflow-y: auto;
    min-height: 0;
  }
  .bed {
    padding: 3px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    line-height: 0;
  }
  .bed.on {
    border-color: #a685ff;
  }
  /* A tile already carrying this layout — the ones worth checking first. */
  .bed.wearing {
    box-shadow: inset 0 0 0 2px #3a2b5e;
  }
  .bedtoggle {
    flex: none;
    padding: 2px 5px;
    border: 0;
    border-bottom: 1px solid #241e3a;
    border-radius: 0;
    background: none;
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
  /* A section head is the whole line, not the triangle on it. Only the arrow
     answered a click, so a list you could collapse looked like a list you
     could not — and the word beside it looked like a label rather than the way
     in. Full width so the pointer finds it anywhere along the row. */
  h2 > button.head {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 2px 4px;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    text-align: left;
  }
  h2 > button.head:hover {
    background: #241e3a;
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
  h2 {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #8f88a8;
  }
  h2.spaced {
    margin-top: 18px;
  }
  .empty {
    margin: 0;
    color: #6f688a;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: 3px;
  }
  /* A bar as well as a tint. The tint alone was 1.4:1 against the panel — the
     faintest signal a list can give, and it was the only one, so a picked row
     and its neighbours read the same at a glance. The bar is what survives
     being glanced at, and it is a shape rather than a shade, so the row does
     not depend on telling two dark greys apart. */
  li.selected,
  .grouphead.selected {
    background: #2b2347;
    box-shadow: inset 3px 0 0 #a685ff;
  }
  /* Rows are clickable and said nothing at all under the pointer. `:has` picks
     the innermost hovered row: layer rows nest, and without it a hover on a
     child lit its parent up as well. */
  li:hover:not(.selected):not(:has(li:hover)) {
    background: #211b38;
  }
  /* A line where the row would land, and a frame when it would land inside —
     an insertion point has to be visible before the mouse is released or the
     drop is a guess. box-shadow rather than a border, so nothing shifts by a
     pixel as the marker moves from row to row. */
  li.drop-before {
    box-shadow: inset 0 2px 0 #a685ff;
  }
  li.drop-after {
    box-shadow: inset 0 -2px 0 #a685ff;
  }
  li.drop-into {
    box-shadow: inset 0 0 0 2px #a685ff;
  }
  li[draggable="true"] {
    cursor: grab;
  }
  /* The same target size as the toolbar. A row's controls are hit as often as
     a tool is, and they were half the size — 32px is one number for the whole
     app rather than one per panel. The name button is exempt: it stretches to
     the row and its height comes from the line. */
  li button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    height: 32px;
    padding: 0 6px;
    font-size: 15px;
  }
  .name {
    flex: 1;
    min-width: 0;
    /* Left-aligned and elastic, unlike the square icon buttons above — and
       block, so a two-line row (name plus its usage count) is not squashed
       into one flex line. */
    display: block;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: inherit;
    border-color: transparent;
    background: none;
  }
  .dimmed {
    color: #6f688a;
  }
  .usage {
    display: block;
    color: #6f688a;
    font-size: 11px;
  }
  .wide {
    width: 100%;
    height: 32px;
    margin-top: 6px;
  }
  .eye {
    border-color: transparent;
    background: none;
  }
  /* The accent the rest of the app uses for "this is switched on". A locked
     layer is a state worth spotting from across the list, not a shape to
     squint at. */
  .eye.on {
    color: #a685ff;
  }
  .group {
    margin-bottom: 6px;
    border-bottom: 1px solid #1b1630;
  }
  /* On the head, not the whole group. Tile rows are groups nested inside the
     section's group, so a hover on one row also hovered its ancestor and the
     entire block lit up — which read as "everything is marked". */
  .grouphead:hover:not(.selected) {
    background: #211b38;
  }
  .grouphead {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
  }
  .grouphead button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    height: 32px;
    padding: 0 6px;
    font-size: 15px;
  }
  .grouphead .name {
    display: block;
    height: auto;
    color: #a685ff;
  }
  .twisty {
    min-width: 22px;
    padding: 0;
    border-color: transparent;
    background: none;
    color: #8f88a8;
  }
  /* Thumbnails on the app's chequerboard rather than on flat colour: a class
     logo is usually transparent, and on a dark panel a dark logo is a dark
     square. */
  .gallery {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-bottom: 6px;
  }
  .swatch {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 2px;
    background:
      linear-gradient(45deg, #221c36 25%, transparent 25%) 0 0 / 10px 10px,
      linear-gradient(-45deg, #221c36 25%, transparent 25%) 0 5px / 10px 10px,
      #16112a;
  }
  .swatch img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  /* A class icon fills its swatch the way a picture does. Scoped to the icon
     swatch and not to `.swatch svg`: that also matched the "no picture" glyph
     in the gallery above, which carries its own 18px size and arrived at 34. */
  .swatch.art svg {
    width: 100%;
    height: 100%;
  }
  .swatch.on {
    border-color: #a685ff;
    box-shadow: inset 0 0 0 1px #a685ff;
  }
  .swatch.none {
    color: #8f88a8;
  }
  /* The gallery's label and the wording field's label name the same kind of
     thing — a layer on this tile — so they are set the same and start on the
     same column. It used to be a small-caps subtitle sitting one notch to the
     left, which read as a heading over the row rather than a label in it. */
  .sub {
    margin: 4px 0 2px 18px;
    color: #8f88a8;
    font-size: 11px;
  }
  .indent {
    margin-left: 18px;
  }
  .assign {
    width: calc(100% - 18px);
    height: 32px;
    margin: 2px 0 6px;
    font: inherit;
    padding: 0 6px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #1d1832;
    color: #8f88a8;
  }
  .rename {
    flex: 1;
    min-width: 0;
    /* Border included, or the field is two pixels taller than the button it
       replaces and every row it opens in jumps down and back. */
    box-sizing: border-box;
    height: 32px;
    font: inherit;
    padding: 0 6px;
    border: 1px solid #a685ff;
    border-radius: 3px;
    background: #0e0b16;
    color: inherit;
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
  .dirty {
    color: #ffc45c;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 4px;
  }
  .field > span:first-child {
    flex: none;
    width: 56px;
    overflow: hidden;
    color: #8f88a8;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .field input {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 2px 4px;
    border: 1px solid #3a444c;
    border-radius: 3px;
    background: #0e0b16;
    color: inherit;
  }
</style>
