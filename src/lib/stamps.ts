/* The stamp subsystem: how a Layout gets onto a tile, stays in step with it,
 * and comes off again.
 *
 * Lifted out of model.ts, where it was some 350 lines inside a file about
 * something else — and where two of the three bugs proven on 10 August lived.
 * A move, not a redesign: every function here is the one that was there, with
 * its reasoning intact.
 *
 * The dependency runs one way. This file knows about the document; the document
 * does not know about stamps. The one exception stayed behind: migrate calls
 * dropOrphanLiveLayers, so that one is still in model.ts rather than making
 * this an import cycle. */
import {
  clone,
  cutApplies,
  findLayer,
  nameInStack,
  nestingShift,
  newImageLayer,
  walkLayers,
  type ImageLayer,
  type Layer,
  type Layout,
  type Manifest,
  type ShapeLayer,
  type TextLayer,
  type Tile,
} from "./model";

/** Every tile carrying a stamp of this layout — what "Update stamps" has to
 *  refresh, and what is left wearing a picture nobody can regenerate if the
 *  layout is deleted.
 *
 *  There used to be a StampHolder here, a `{ layers, tiles }` pair, from when a
 *  stamp could also sit on a group's shared stack. Groups lost theirs, so every
 *  holder was one tile and `tiles` was a one-element literal — which made "how
 *  many stamps" and "how many portraits" the same number by construction, and
 *  the Layout row printed it twice ("1 stamp(s) · 1 tile(s)"). Checked before
 *  removing it: no v6 document brings the old shape back either, because toV7
 *  clones overlay layers onto each tile before anything counts them.
 *
 *  `!l.live` for the reason stampInto and refreshStamps both state: a live copy
 *  is a per-tile picture or a cutter that travelled, not a stamp. It cannot
 *  change the answer today — a live copy only ever exists beside its stamp — so
 *  this is here to keep the three predicates saying the same thing rather than
 *  to fix a count. */
export function tilesWearing(m: Manifest, layoutId: string): Tile[] {
  return Object.values(m.tiles).filter((t) =>
    t.layers.some((l) => l.kind === "image" && l.layoutId === layoutId && !l.live),
  );
}

/** Puts a rendered stamp of `layoutId` into a layer stack — a group's or one
 *  tile's own; it needs nothing from either but the list.
 *
 *  Re-stamping the same layout onto the same tiles replaces that stamp's
 *  picture rather than stacking a second copy on top of the first — which
 *  would look like nothing happened while quietly doubling the layer count. */
export function stampInto(into: { layers: Layer[] }, layoutId: string, asset: string): ImageLayer {
  // Not a live picture the same Layout keeps on these tiles: that also carries
  // this layoutId, and grabbing it here would overwrite a per-tile logo with
  // the whole flattened sheet.
  const existing = into.layers.find(
    (l): l is ImageLayer => l.kind === "image" && l.layoutId === layoutId && !l.live,
  );
  if (existing) {
    existing.asset = asset;
    return existing;
  }
  const stamp = newImageLayer(asset);
  stamp.layoutId = layoutId;
  /* A stamp is rendered at exactly tile resolution, so 1 is the only scale that
   * reproduces the Layout as it was composed. newImageLayer's smaller default
   * is for a picture dropped in by hand, where landing full-bleed would be
   * wrong — here it shrank the whole sheet to a patch in the middle of the
   * tile, which reads as "the stamp did not arrive". */
  stamp.scale = 1;
  into.layers.push(stamp);
  return stamp;
}

/** Points every stamp of `layoutId` at a freshly rendered picture, wherever it
 *  sits. Returns how many were refreshed — a design used in several places has
 *  to update everywhere at once, not be re-stamped by hand at each. */
export function refreshStamps(m: Manifest, layoutId: string, asset: string): number {
  let n = 0;
  for (const tile of Object.values(m.tiles)) {
    for (const l of tile.layers) {
      /* `!l.live` for the reason stampInto states: a live copy is a per-tile
         picture or a cutter that travelled, and pointing it at the flattened
         sheet would replace what the tile chose. syncLiveLayers happened to
         repair it straight afterwards, which made the count wrong ("36 stamp(s)
         updated" for twelve) and the correctness a matter of call order. */
      if (l.kind === "image" && l.layoutId === layoutId && !l.live) {
        l.asset = asset;
        n++;
      }
    }
  }
  return n;
}

/** A layer a Layout keeps live on the tiles instead of baking into its stamp.
 *  Text carries its own wording per tile, an image its own picture — the same
 *  bargain either way: the Layout owns how it looks, the tile owns what it
 *  says or shows.
 *
 *  A shape is in the club for a quieter reason: it has no per-tile content of
 *  its own, but the thing that cuts it can — a gradient block cut by each
 *  character's own class icon. The rule says a per-tile cutter may only cut a
 *  per-tile layer, and without this a shape could never satisfy it: the
 *  checkbox did not exist for shapes, so the combination was simply
 *  unreachable and the mask fell off as "no longer allowed". */
export type LiveLayer = TextLayer | ImageLayer | ShapeLayer;

/** Is this layer on a tile a Layout's live copy, rather than its stamp?
 *
 *  Both carry the same layoutId and both can be images, so kind alone cannot
 *  tell them apart — `live` is what says which is which. Text counts either
 *  way: a stamp is never text, and captions stamped before `live` existed
 *  carry no flag at all.
 *
 *  One rule, because three places ask it: the withdrawal pass below, and the
 *  tile list, which speaks for a Layout with a single row. Written twice, the
 *  list's copy said "text" where this one says "a copy" — so a per-tile
 *  picture appeared as a second row for the same layout. */
export const isLiveCopy = (l: Layer) => !!l.layoutId && (!!l.live || l.kind === "text");

/** Which layouts are switched off on this tile, by the eye on their stamp. */
export const offLayouts = (layers: Layer[]): Set<string> =>
  new Set(
    layers
      .filter((l) => l.kind === "image" && !l.live && l.hidden && l.layoutId)
      .map((l) => l.layoutId!),
  );

/** Whether a layer on a tile draws.
 *
 *  A live copy answers to two eyes and owns neither. One is the Layout's, which
 *  arrives as its own `hidden` because the copy is rebuilt from that layer. The
 *  other is its stamp's — the only switch the wall has for the whole
 *  assignment, since live copies have no row of their own (see `stampsOf`).
 *
 *  Asked, rather than mirrored onto the copy. Mirroring is what the eye used to
 *  do, and `syncLiveLayers` rebuilds that copy from the Layout on every "Update
 *  stamps": the mirrored value was overwritten, and a design switched off came
 *  back — captions and all, into the file written to the game — with the row
 *  still saying "hidden". Neither eye wins here; they compose. */
export const layerShows = (l: Layer, off: Set<string>) =>
  !l.hidden && !(isLiveCopy(l) && !!l.layoutId && off.has(l.layoutId));

const perTileLayers = (layout: Layout): LiveLayer[] =>
  [...walkLayers(layout.layers)].filter((l): l is LiveLayer => l.kind !== "group" && !!l.perTile);

/** The Layout as it goes into the stamp: everything except the live captions.
 *
 *  Groups are rebuilt without their live members rather than dropped, so the
 *  displacement a group applies to its remaining children still holds. */
export function bakeable(layout: Layout): Layout {
  const keep = (layers: Layer[]): Layer[] =>
    layers
      .filter((l) => !(l.kind !== "group" && l.perTile))
      .map((l) => (l.kind === "group" ? { ...l, children: keep(l.children) } : l));
  return { ...layout, layers: keep(layout.layers) };
}

/** Puts a Layout's live captions on the tile, beside its stamp, and takes
 *  away the ones it no longer has.
 *
 *  Ids are carried over deliberately: per-tile wording lives in `tile.text`
 *  keyed by layer id, so keeping the id is what lets a caption be repositioned
 *  or restyled in the Layout without every tile losing what it says.
 *
 *  A caption nested in a group renders at its own position plus that group's
 *  displacement; there is no group on the tile, so the displacement is folded
 *  in on the way over — the same fold removeLayerFrom does when a group is
 *  dissolved. */
/** The layers a live copy needs beside it to look the way it did in the Layout.
 *
 *  Only one so far: the shape it is cut by. A per-tile layer leaves the Layout
 *  and the thing that cuts it does not, so on the tile its `maskId` used to
 *  resolve to nothing and the picture came back whole — which is why the two
 *  settings locked each other out. Sending the cutter along is what unlocks
 *  them.
 *
 *  Nested cutters get the same fold as the layer itself: there are no groups on
 *  a tile, so the displacement has to be baked into the position on the way
 *  over or the cut lands somewhere else entirely.
 *
 *  A cutter that is itself editable in the grid needs no copy from here: it is
 *  already on its way over as a live layer of its own, wording and all. What it
 *  may not do is cut something that stays behind in the stamp — cutApplies is
 *  where that is decided, for this and for every other reader. */
function cuttersFor(live: LiveLayer[], layout: Layout): Layer[] {
  const out: Layer[] = [];
  const travelling = new Set(live.map((l) => l.id));
  for (const l of live) {
    if (!l.maskId) continue;
    const cutter = findLayer(layout.layers, l.maskId);
    if (!cutApplies(l, cutter) || !cutter) continue;
    /* A cutter that is per-tile in its own right is already on its way over as
     * a live layer — the loop below copies it, wording and all. Copying it
     * here as well would just write the same id twice. */
    if (travelling.has(cutter.id) || out.some((x) => x.id === cutter.id)) continue;
    const shift = nestingShift(layout.layers, cutter.id) ?? { dx: 0, dy: 0 };
    out.push({ ...clone(cutter), x: cutter.x + shift.dx, y: cutter.y + shift.dy });
  }
  return out;
}

export function syncLiveLayers(into: { layers: Layer[] }, layout: Layout): number {
  const live = perTileLayers(layout);
  const cutters = cuttersFor(live, layout);
  // Both kept, so the withdrawal pass below leaves the cutters standing for as
  // long as something on the tile is still cut by them.
  const wanted = new Set([...live, ...cutters].map((l) => l.id));

  for (const cutter of cutters) {
    const copy: Layer = { ...cutter, layoutId: layout.id, perTile: undefined, live: true };
    const at = into.layers.findIndex((l) => l.id === cutter.id);
    if (at >= 0) into.layers[at] = copy;
    else into.layers.push(copy);
  }

  for (const src of live) {
    const shift = nestingShift(layout.layers, src.id) ?? { dx: 0, dy: 0 };
    const copy: LiveLayer = {
      ...clone(src),
      x: src.x + shift.dx,
      y: src.y + shift.dy,
      layoutId: layout.id,
      // Meaningless once it is on a tile, where a live layer is live by
      // construction — and `live` is what says so.
      perTile: undefined,
      live: true,
    };
    const at = into.layers.findIndex((l) => l.id === src.id);
    if (at >= 0) into.layers[at] = copy;
    else into.layers.push(copy);
  }

  /* Withdraw the copies this Layout no longer keeps live. `live` is what keeps
   * the stamp out of it: the stamp is an image carrying the same layoutId, and
   * a rule written on kind and layoutId alone would delete the whole design
   * the moment a per-tile picture was switched off. */
  for (let i = into.layers.length - 1; i >= 0; i--) {
    const l = into.layers[i];
    if (isLiveCopy(l) && l.layoutId === layout.id && !wanted.has(l.id)) into.layers.splice(i, 1);
  }
  return live.length;
}

/** Drops every layer whose `layoutId` names a layout the library no longer has,
 *  on every tile, and says how many went.
 *
 *  The enforcement of one rule: a layout and its layers on the wall do not
 *  survive each other. Deleting a layout cascades through this, and it runs
 *  again on every open — because there are ways for dead references to arrive
 *  that no cascade can see: manifests written before the cascade existed, and a
 *  project snapshot bringing back stamps of a layout deleted since it was
 *  taken. Without the sweep those sat on the tiles as pictures nothing could
 *  name, which on a real wall was sixteen layers nobody could account for.
 *
 *  Top-level only, which is where every stamp and live copy lives — stampInto
 *  and syncLiveLayers push into the tile's own list, never into a group.
 *
 *  The wording and the per-tile picture go with the layer, because both are
 *  keyed by layer id and the layer is what reaches them. Only here, though, and
 *  deliberately not when a Layout merely switches a caption off: there the same
 *  id comes back the moment it is switched on again, and with it every word
 *  that was typed on every tile. A deleted Layout has no way back. */
export function pruneDeadLayoutRefs(m: Manifest): number {
  const alive = new Set(m.layouts.map((l) => l.id));
  let dropped = 0;
  for (const tile of Object.values(m.tiles)) {
    const before = tile.layers.length;
    const gone = tile.layers.filter((l) => l.layoutId && !alive.has(l.layoutId));
    tile.layers = tile.layers.filter((l) => !l.layoutId || alive.has(l.layoutId));
    for (const l of gone) {
      delete tile.text[l.id];
      delete tile.swap?.[l.id];
      /* And where the tile put it, and what colour it painted it. Keyed by
         layer id like the other two, so they have to go with the layer for the
         same reason — and more sharply: live copies keep the id they came from,
         so a Layout deleted and stamped again would have brought every old
         placement and colour back with it. */
      delete tile.frame?.[l.id];
      delete tile.paint?.[l.id];
    }
    dropped += before - tile.layers.length;
  }
  return dropped;
}

/** A stamp and every live layer the same Layout keeps beside it.
 *
 *  The list shows one row for the lot, so everything that row does — hide,
 *  delete — has to reach the copies as well: they have no row of their own,
 *  and a caption left drawing on the wall with nothing to switch it off is
 *  precisely the bug this has already produced twice.
 *
 *  Anything that is not a stamp is a family of one, which is what keeps the
 *  callers free of special cases. */
export function stampFamily(layers: Layer[], stampId: string): Layer[] {
  const stamp = layers.find((l) => l.id === stampId);
  if (!stamp) return [];
  const owner = stamp.kind === "image" && !stamp.live ? stamp.layoutId : undefined;
  return layers.filter(
    (l) => l.id === stampId || (owner !== undefined && l.layoutId === owner && isLiveCopy(l)),
  );
}

/** Deletes a stamp and every live layer the same Layout keeps beside it.
 *
 *  They are copies the Layout owns, not artwork of the tile's own: without the
 *  stamp they belong to nothing. One click, one undo step, the whole
 *  assignment gone. */
export function deleteStampCascade(layers: Layer[], stampId: string): number {
  const doomed = new Set(stampFamily(layers, stampId).map((l) => l.id));
  /* Spliced in place rather than returned as a new array: the caller hands us a
   * live Svelte $state array. Backwards, so removing one does not shift the
   * index of the next. */
  for (let i = layers.length - 1; i >= 0; i--) if (doomed.has(layers[i].id)) layers.splice(i, 1);
  return doomed.size;
}
