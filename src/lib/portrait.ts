/* Showing a tile's own portrait in the interface, wherever the interface asks:
 * the cards on the overview, the shelf, the tile rows, the strip beside a
 * Layout. Every one of them wants the same picture at a different size, and
 * none of them owns it. */
import { app } from "./editor.svelte";

/** An object URL for a stored asset, for gallery thumbnails.
 *
 *  Through the same loader the canvas uses, which caches per asset — so
 *  showing the same logo on twenty tiles costs one decode. */
export const assetUrl = (asset: string) => app.deps?.asset(asset) ?? Promise.resolve("");

/** Paints a tile's untouched portrait into a small canvas.
 *
 *  Through `deps.original`, which is the same cached loader the wall uses, so
 *  a thumbnail costs no decode of its own. A canvas rather than an image
 *  element, because that loader hands back an ImageBitmap and there is no URL
 *  for one — and adding a second IO path for pictures the app already holds in
 *  memory would be a cache to keep in step for no gain. */
export function portrait(el: HTMLCanvasElement, arg: { id: string; ready: boolean }) {
  let live = true;
  let asked = "";

  /* Waits for the pixel source instead of shrugging at it. The overview is
     drawn from the manifest, which lands well before `app.deps` — the reader
     that knows how to fetch a portrait — so on a cold start every card asked a
     null and got nothing back. The action ran once per canvas and nothing ever
     tried again, which is why the squares stayed black for as long as you
     cared to wait. `ready` flips when the deps arrive and Svelte calls
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
     in front, a thumbnail that could not be decoded looked exactly like a tile
     with nothing to show yet. Once per thumbnail: `asked` guards the reload,
     so a broken file cannot fill the line on every redraw. */
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
