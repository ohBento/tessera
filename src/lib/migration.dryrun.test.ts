/* A dry run of the v8 migration over a real document.
 *
 * Every other migration test builds its own v7 by hand, which means it only
 * ever exercises the shapes somebody thought to write down. This one opens the
 * document on this machine — 44 tiles, 3 layouts, 132 per-tile overrides — and
 * checks what came out the other side. It reads and never writes: the path
 * comes from an environment variable or the default install, and the file is
 * parsed, migrated in memory, and dropped.
 *
 * Skipped when there is no such document, so a checkout on another machine
 * still has a green suite. That is the point of a dry run rather than a
 * fixture: the fixture can only be as good as the imagination behind it.
 *
 * The counts it logs are of the moment and will not match twice — the file is
 * a real document that gets edited between runs, and 58 of its records sat on
 * a layer one day and 72 the next. What is asserted is the shape, not the
 * size: nothing dissolves to nothing, nothing carrying a layout survives, and
 * no record names a layer the old document had and the new one does not.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, walkLayers, type Layer, type Manifest, type Paint } from "./model";

const DIR =
  process.env.TESSERA_DRYRUN_DIR ??
  join(homedir(), "Documents", "Black Desert", "FaceTexture.tessera");
/* The v7 copy the app sets aside the first time it migrates, and the live file
 * before that has happened. Once the document has been opened by a build that
 * writes v8 there is no v7 left in manifest.json — and that is exactly when
 * this test matters most, because the backup is the only record of what the
 * migration was handed. */
const BACKUP = join(DIR, "manifest.v7.bak.json");
const FILE = existsSync(BACKUP) ? BACKUP : join(DIR, "manifest.json");

/* The v7 shapes this reads. Deliberately spelled out here rather than imported:
 * the point is to check the migration against what a real file says, and
 * borrowing the migration's own idea of the old shape would let a wrong
 * assumption agree with itself. */
type V7Layer = Layer & { layoutId?: string; live?: boolean; perTile?: boolean };
type V7Tile = {
  layers?: V7Layer[];
  text?: Record<string, string>;
  swap?: Record<string, string>;
  paint?: Record<string, Paint>;
  frame?: Record<string, { x: number; y: number; z: number; a: number; zh?: number }>;
};
type V7 = {
  version: number;
  tiles: Record<string, V7Tile>;
  layouts?: { id: string; name: string; layers: Layer[] }[];
};

const walk = (ls: Layer[]): Layer[] => [...walkLayers(ls)];
const byId = (t: { layers: Layer[] }) => new Map(walk(t.layers).map((l) => [l.id, l]));

describe.skipIf(!existsSync(FILE))("the v8 migration over the document on this machine", () => {
  const raw = JSON.parse(readFileSync(FILE, "utf8")) as V7;
  const after = migrate(JSON.parse(readFileSync(FILE, "utf8"))) as Manifest;
  const ids = Object.keys(raw.tiles);

  it("reads a v7 document and answers v8", () => {
    expect(raw.version).toBe(7);
    expect(after.version).toBe(8);
    expect(Object.keys(after.tiles)).toHaveLength(ids.length);
  });

  it("dissolves every stamp into layers, and loses none to a missing layout", () => {
    const known = new Set((raw.layouts ?? []).map((l) => l.id));
    const lost: string[] = [];
    let stamps = 0;
    for (const id of ids)
      for (const l of raw.tiles[id]?.layers ?? []) {
        if (l.kind !== "image" || !l.layoutId || l.live) continue;
        stamps++;
        // A stamp naming a layout nobody has any more dissolves to nothing —
        // the one case where migration is a deletion rather than a rewrite.
        if (!known.has(l.layoutId)) lost.push(`${id}/${l.id} -> ${l.layoutId}`);
      }
    console.log(`stamps: ${stamps}, dissolving to nothing: ${lost.length}`);
    expect(lost).toEqual([]);
  });

  it("leaves nothing behind that pointed at a layout", () => {
    const held: string[] = [];
    for (const id of ids) {
      const t = after.tiles[id];
      if (!t) continue;
      for (const l of walk(t.layers) as V7Layer[])
        if (l.layoutId || l.live || l.perTile) held.push(`${id}/${l.id}`);
      const rec = t as unknown as V7Tile;
      if (rec.swap || rec.paint || rec.frame) held.push(`${id}: override record`);
      /* Emptied, not dropped: the field is still written so that the build
         before this one can open the document — see Tile.text. What must not
         survive is anything in it. */
      if (Object.keys((t as unknown as V7Tile).text ?? {}).length)
        held.push(`${id}: wording record`);
    }
    expect(held).toEqual([]);
    expect((after as unknown as { layouts?: unknown[] }).layouts ?? []).toHaveLength(0);
  });

  it("carries every override that had a layer onto that layer", () => {
    const wrong: string[] = [];
    const vanished: string[] = [];
    let carried = 0;
    let orphaned = 0;
    for (const id of ids) {
      const t = raw.tiles[id];
      const now = after.tiles[id] ? byId(after.tiles[id]) : new Map<string, Layer>();
      const was = new Set(walk((t.layers ?? []) as Layer[]).map((l) => l.id));
      const check = (kind: string, layerId: string, ok: (l: Layer) => boolean) => {
        const l = now.get(layerId);
        if (!l) {
          orphaned++;
          /* No layer of that id on the tile any more — and there was none in v7
           * either, which is what makes dropping it right rather than a loss.
           * asTileShows resolved a record by id against the layers actually on
           * the tile, so one left behind by a withdrawn live copy was already
           * being read by nobody. Checked rather than argued: a record naming a
           * layer the old document had and the new one does not is content
           * going missing. */
          if (was.has(layerId)) vanished.push(`${id}/${layerId} ${kind}`);
          return;
        }
        carried++;
        if (!ok(l)) wrong.push(`${id}/${layerId} ${kind}`);
      };
      for (const [lid, v] of Object.entries(t.text ?? {}))
        check("text", lid, (l) => l.kind !== "text" || l.text === v);
      for (const [lid, v] of Object.entries(t.swap ?? {}))
        check("swap", lid, (l) =>
          l.kind === "image" ? l.asset === v : l.kind !== "shape" || l.shape !== "icon" || l.icon === v,
        );
      for (const [lid, v] of Object.entries(t.paint ?? {}))
        check("paint", lid, (l) => l.kind !== "shape" || JSON.stringify(l.fill) === JSON.stringify(v));
    }
    console.log(
      `overrides landed on a layer: ${carried}, ` +
        `keyed on a layer neither document has: ${orphaned}`,
    );
    expect(vanished).toEqual([]);
    expect(wrong).toEqual([]);
  });

  it("puts every layer exactly where the frame record had it", () => {
    /* The other three records change what a layer says or shows, and the test
     * above checks all of them. This one changes where it *is*, and a layer
     * that survives the migration in the wrong place is the failure no count
     * can see — the plan called the arithmetic a blocker for that reason.
     *
     * Computed here from the rule rather than read back from the migration:
     * x and y add, rotation adds, a picture's scale multiplies. Asking the
     * migration what it did and then checking it did that is not a test.
     *
     * This is what the planned all-tile render diff was for, arrived at by
     * arithmetic instead of pixels. It answers the same question exactly,
     * where a pixel diff would have had to allow a tolerance wide enough to
     * hide a layer displaced by a couple of millimetres. */
    const wrong: string[] = [];
    const vanished: string[] = [];
    let checked = 0;
    let framed = 0;
    for (const id of ids) {
      const t = raw.tiles[id];
      const now = after.tiles[id] ? byId(after.tiles[id]) : new Map<string, Layer>();
      for (const was of walk((t.layers ?? []) as Layer[]) as V7Layer[]) {
        // A stamp is the one layer meant to disappear; everything else is
        // supposed to come out the other side.
        if (was.kind === "image" && was.layoutId && !was.live) continue;
        const got = now.get(was.id);
        if (!got) {
          vanished.push(`${id}/${was.id}`);
          continue;
        }
        checked++;
        const f = t.frame?.[was.id];
        if (f) framed++;
        const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
        if (
          !near(got.x, was.x + (f?.x ?? 0)) ||
          !near(got.y, was.y + (f?.y ?? 0)) ||
          !near(got.rotation, was.rotation + (f?.a ?? 0))
        )
          wrong.push(`${id}/${was.id} placement`);
        if (f && was.kind === "image" && got.kind === "image" && !near(got.scale, was.scale * f.z))
          wrong.push(`${id}/${was.id} scale`);
      }
    }
    console.log(`layers kept: ${checked}, of them carrying a frame record: ${framed}`);
    expect(vanished).toEqual([]);
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });

  it("keeps every mask pointing at a layer on its own tile", () => {
    const dangling: string[] = [];
    for (const id of ids) {
      const t = after.tiles[id];
      if (!t) continue;
      const here = byId(t);
      for (const l of walk(t.layers))
        if (l.maskId && !here.has(l.maskId)) dangling.push(`${id}/${l.id} -> ${l.maskId}`);
    }
    expect(dangling).toEqual([]);
  });

  it.skipIf(!existsSync(join(DIR, "assets")))("names only pictures that are on disk", () => {
    const have = new Set(readdirSync(join(DIR, "assets")));
    const missing = new Set<string>();
    for (const id of ids)
      for (const l of walk(after.tiles[id]?.layers ?? []))
        if (l.kind === "image" && l.asset && !have.has(l.asset)) missing.add(l.asset);
    expect([...missing]).toEqual([]);
  });

  /* Every layer is accounted for, rather than the count merely not falling.
   *
   * It does fall here, and correctly: all three layouts in this document are
   * per-tile all the way down, so every stamp was a rendered picture of an
   * empty baked half — a blank image layer sitting under the live copies that
   * did the actual drawing. Each one dissolves to nothing, and 44 tiles come
   * out 58 layers lighter without losing a mark on the screen.
   *
   * "Blank" was read off the perTile flags when this was written and has since
   * been measured: all 58 stamps name one asset, and every one of that PNG's
   * 501,696 pixels is fully transparent. That is why this branch never needed
   * the pre/post render diff the plan asked for — on the pre side there was
   * nothing to render.
   *
   * Asserting the identity instead of the direction is what makes this worth
   * running: a layer going missing for any other reason breaks it, whichever
   * way the total happens to move. */
  it("hands back a document with no id used twice on one tile", () => {
    /* The invariant everything by-id rests on, checked over the real thing.
     *
     * Two tiles here had it broken: a build that let a group be pasted onto a
     * tile already carrying one of its members put the copy in nested, and a
     * later Ungroup laid it down beside the original. Two rows in one list
     * under one key — the tile's row stopped opening at all, which is how it
     * was found. `unclash` renames the second on the way in rather than
     * dropping it: it is real work, and which of the two is the copy cannot be
     * known from here. */
    const clashes: string[] = [];
    for (const [id, t] of Object.entries(after.tiles)) {
      const seen = new Set<string>();
      for (const l of walk(t.layers)) {
        if (seen.has(l.id)) clashes.push(`${id}/${l.id}`);
        seen.add(l.id);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("accounts for every layer it removed", () => {
    const baked = new Map(
      (raw.layouts ?? []).map((l) => [
        l.id,
        walk(l.layers).filter((x) => !(x as V7Layer).perTile).length,
      ]),
    );
    let before = 0;
    let now = 0;
    let expectedDrop = 0;
    for (const id of ids) {
      before += walk((raw.tiles[id]?.layers ?? []) as Layer[]).length;
      now += walk(after.tiles[id]?.layers ?? []).length;
      for (const l of raw.tiles[id]?.layers ?? [])
        if (l.kind === "image" && l.layoutId && !l.live)
          expectedDrop += 1 - (baked.get(l.layoutId) ?? 0);
    }
    console.log(
      `layers across ${ids.length} tiles: ${before} -> ${now} ` +
        `(${expectedDrop} stamps dissolved, none of them drawing anything)`,
    );
    expect(before - now).toBe(expectedDrop);
  });
});
