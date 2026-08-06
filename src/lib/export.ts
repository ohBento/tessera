/* Export renders the same scene the editor shows and moves a 624x804 window
 * across it, once per tile. There is no separate export renderer to keep in
 * sync — that is the whole point. */
import * as fabric from "fabric";
import { writeFile } from "./platform";

import { encodeBmp32, TILE_H, TILE_W } from "./bmp";
import { visibleTiles, type Manifest } from "./model";
import { tilePath, vaultOriginal } from "./project";
import { buildGrid, cellAt, type SceneDeps } from "./scene";

/** Every visible tile as finished BMP bytes, keyed by tile id. */
export async function renderTiles(m: Manifest, deps: SceneDeps): Promise<Map<string, Uint8Array>> {
  const canvas = new fabric.StaticCanvas(undefined, {
    width: TILE_W,
    height: TILE_H,
    // Without this the backing store is multiplied by devicePixelRatio and
    // getImageData hands back a differently sized buffer than encodeBmp32 wants.
    enableRetinaScaling: false,
  });
  try {
    await buildGrid(canvas, m, deps);
    const ctx = canvas.getElement().getContext("2d")!;
    const ids = visibleTiles(m);

    const out = new Map<string, Uint8Array>();
    for (const [index, id] of ids.entries()) {
      const at = cellAt(index);
      canvas.viewportTransform = [1, 0, 0, 1, -at.x, -at.y];
      canvas.renderAll();
      out.set(id, encodeBmp32(ctx.getImageData(0, 0, TILE_W, TILE_H).data));
    }
    return out;
  } finally {
    // Fabric v6 disposes asynchronously; not awaiting it leaves the element
    // half torn down and quietly corrupts the next canvas built on it.
    await canvas.dispose();
  }
}

/** Writes the rendered tiles into the game folder, vaulting each pristine
 *  original first. Vaulting before the first overwrite is the only thing
 *  standing between a user and unrecoverable portraits. */
export async function saveTiles(dir: string, m: Manifest, deps: SceneDeps): Promise<number> {
  const tiles = await renderTiles(m, deps);
  for (const [id, bytes] of tiles) {
    await vaultOriginal(dir, id);
    await writeFile(await tilePath(dir, id), bytes);
  }
  return tiles.size;
}
