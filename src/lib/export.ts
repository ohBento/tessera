/* Export renders the same scene the editor shows and moves a 624x804 window
 * across it, once per tile. There is no separate export renderer to keep in
 * sync — that is the whole point. */
import { writeFile } from "./platform";

import { encodeBmp32, TILE_H, TILE_W } from "./bmp";
import { type Manifest } from "./model";
import { hashBytes, loadFingerprints, saveFingerprints, tilePath, vaultOriginal } from "./project";
import { buildGrid, cellAt, withTileCanvas, type SceneDeps, type Wall } from "./scene";

/** Every placed tile of one wall as finished BMP bytes, keyed by tile id.
 *
 *  The same id list the scene was built from, not a second derivation of it:
 *  the index positions the export window and the id keys the result, so the two
 *  have to be the same array or a portrait is written under its neighbour's
 *  name. */
export async function renderTiles(
  wall: Wall,
  m: Manifest,
  deps: SceneDeps,
): Promise<Map<string, Uint8Array>> {
  return withTileCanvas(async (canvas) => {
    await buildGrid(canvas, wall, m, deps);
    const ctx = canvas.getElement().getContext("2d")!;
    const ids = wall.ids;

    const out = new Map<string, Uint8Array>();
    for (const [index, id] of ids.entries()) {
      const at = cellAt(index);
      canvas.viewportTransform = [1, 0, 0, 1, -at.x, -at.y];
      canvas.renderAll();
      out.set(id, encodeBmp32(ctx.getImageData(0, 0, TILE_W, TILE_H).data));
    }
    return out;
  });
}

/** Writes the rendered tiles into the game folder, vaulting each pristine
 *  original first. Vaulting before the first overwrite is the only thing
 *  standing between a user and unrecoverable portraits. */
export async function saveTiles(
  dir: string,
  wall: Wall,
  m: Manifest,
  deps: SceneDeps,
): Promise<number> {
  const tiles = await renderTiles(wall, m, deps);
  const { prints } = await loadFingerprints(dir);
  /* In a `finally`, because a write that stops halfway is exactly when this
   * matters. A locked file or a full disk at tile seven used to leave six
   * portraits written and not one `written` hash saved: on the next open none
   * of them matched either hash, so the app reported its own work as "changed
   * in the game" — and answering that with "new characters" costs the layers
   * and the vault copies. What was written is recorded, however the loop
   * ended. */
  try {
    for (const [id, bytes] of tiles) {
      await vaultOriginal(dir, id);
      await writeFile(await tilePath(dir, id), bytes);
      /* Remembered here rather than re-read on the next open: this is the one
       * place that knows the bytes were ours. Without it every open after a
       * write would report the whole wall as changed by the game — by the app's
       * own hand — and the question that matters would be buried in the
       * noise. */
      prints[id] = { ...prints[id], written: await hashBytes(bytes) };
    }
  } finally {
    await saveFingerprints(dir, prints);
  }
  return tiles.size;
}
