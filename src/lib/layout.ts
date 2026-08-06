/* Rendering a Layout down to one flat picture — the "stamp" a Layout produces.
 * What lands on a tile is never the Layout's own layers; it is always this
 * picture, dropped in as an ordinary image layer. That is what keeps stamped
 * content on the same rails as every other picture (export, previews, undo)
 * without a second render path for it. */
import * as fabric from "fabric";

import { TILE_H, TILE_W } from "./bmp";
import { bakeable, type Layout } from "./model";
import { buildLayout, type SceneDeps } from "./scene";

/** Renders a Layout at tile resolution and returns it as PNG bytes.
 *
 *  A PNG, not a hand-rolled encoder like bmp.ts's: nothing downstream cares
 *  about this file's format beyond "a picture importAsset-shaped code can
 *  decode", so the browser's own canvas.toBlob is the whole implementation —
 *  writing another encoder here would just be a second one to keep correct. */
export async function renderLayout(layout: Layout, deps: SceneDeps): Promise<Uint8Array> {
  const canvas = new fabric.StaticCanvas(undefined, {
    width: TILE_W,
    height: TILE_H,
    enableRetinaScaling: false,
  });
  try {
    /* Live captions are left out here and copied onto the tiles instead — see
     * syncLiveLayers. Baking one would turn it into pixels, and pixels cannot
     * say a different word on every tile. The editor still shows it, so what
     * you compose is what you get; only this one path drops it. */
    await buildLayout(canvas, bakeable(layout), deps);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.getElement().toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("The layout could not be rendered");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    // Fabric v6+ disposes asynchronously; not awaiting it leaves the element
    // half torn down and quietly corrupts the next canvas built on it.
    await canvas.dispose();
  }
}
