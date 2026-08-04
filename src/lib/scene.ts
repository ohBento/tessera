/* The one scene builder. The editor canvas, the previews and the BMP export all
 * call buildGrid — there is deliberately no second drawing path, because two
 * implementations of the same rules is what made every fix break something else.
 *
 * Coordinates are grid pixels: the whole wall is COLS x rows tiles of
 * TILE_W x TILE_H. A tile is a window onto that, which is all "export tile n"
 * means — same scene, different viewportTransform. */
import * as fabric from "fabric";

import { TILE_H, TILE_W } from "./bmp";
import { resolveLayers, type Layer, type Manifest } from "./model";
import { COLS } from "./render";

export const rowsFor = (count: number) => Math.ceil(count / COLS);

export const gridSize = (count: number) => ({
  w: COLS * TILE_W,
  h: rowsFor(count) * TILE_H,
});

/** Top-left corner of the nth grid slot, in grid pixels. */
export const cellAt = (index: number) => ({
  x: (index % COLS) * TILE_W,
  y: Math.floor(index / COLS) * TILE_H,
});

/** What a Fabric object remembers about where it came from, so a drag can be
 *  written back to the right layer without searching the model for a match. */
export type Tagged = fabric.Object & {
  layerId: string;
  /** "" for a grid-space layer, which belongs to no single tile. */
  tileId: string;
  space: "tile" | "grid";
};

/** Fabric's ImageSource does not include ImageBitmap even though a 2d context
 *  draws one happily, so round-trip through a plain canvas once. */
function toCanvas(bmp: ImageBitmap): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  return c;
}

/** Where pixels come from. Injected rather than imported so this module never
 *  reaches for Tauri: the render chain then runs in a plain browser, which is
 *  what makes the golden tests possible at all. project.ts supplies the real
 *  implementation, tests supply synthetic pictures. */
export type SceneDeps = {
  /** The tile as the game shipped it. */
  original: (id: string) => Promise<ImageBitmap>;
  /** Object URL for an imported asset. */
  asset: (name: string) => Promise<string>;
};

async function imageObject(
  l: Layer & { kind: "image" },
  deps: SceneDeps,
  box: { w: number; h: number; x: number; y: number },
): Promise<fabric.Object> {
  const img = await fabric.FabricImage.fromURL(await deps.asset(l.asset));
  img.scaleToWidth(l.scale * box.w);
  img.set({
    originX: "center",
    originY: "center",
    left: box.x + l.x * box.w,
    top: box.y + l.y * box.h,
    angle: l.rotation,
    opacity: l.opacity,
    flipX: !!l.flipX,
    flipY: !!l.flipY,
  });
  return img;
}

/** Only corner handles: the model carries one `scale` per image layer, so a
 *  side handle would offer a non-uniform stretch it cannot store. */
function makeInteractive(obj: fabric.Object, locked: boolean) {
  obj.selectable = !locked;
  obj.evented = !locked;
  obj.hasControls = !locked;
  obj.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false, mtr: true });
}

/** Fills `canvas` with the whole wall. Backgrounds are inert; layers are
 *  interactive when `interactive` is set (the editor) and not when it is not
 *  (export, previews, golden tests). */
export async function buildGrid(
  canvas: fabric.StaticCanvas,
  m: Manifest,
  deps: SceneDeps,
  interactive = false,
): Promise<void> {
  canvas.remove(...canvas.getObjects());

  const ids = m.order.filter((id) => !m.hidden.includes(id));
  const grid = gridSize(ids.length);

  for (const [index, id] of ids.entries()) {
    const at = cellAt(index);

    const bmp = toCanvas(await deps.original(id));
    canvas.add(
      new fabric.FabricImage(bmp, {
        left: at.x,
        top: at.y,
        originX: "left",
        originY: "top",
        scaleX: TILE_W / bmp.width,
        scaleY: TILE_H / bmp.height,
        selectable: false,
        evented: false,
      }),
    );

    for (const l of resolveLayers(m, id)) {
      if (l.hidden || l.kind !== "image" || l.space === "grid") continue;
      const obj = await imageObject(l, deps, { w: TILE_W, h: TILE_H, x: at.x, y: at.y });
      if (interactive) makeInteractive(obj, !!l.locked);
      else obj.selectable = obj.evented = false;
      Object.assign(obj, { layerId: l.id, tileId: id, space: "tile" });
      canvas.add(obj);
    }
  }

  /* Grid-space layers are project scope by nature and are placed once, on top
   * of every tile — drawing them per tile would paint the same pixels COLS*rows
   * times over. */
  for (const l of m.shared) {
    if (l.hidden || l.kind !== "image" || l.space !== "grid") continue;
    const obj = await imageObject(l, deps, { w: grid.w, h: grid.h, x: 0, y: 0 });
    if (interactive) makeInteractive(obj, !!l.locked);
    else obj.selectable = obj.evented = false;
    Object.assign(obj, { layerId: l.id, tileId: "", space: "grid" });
    canvas.add(obj);
  }

  canvas.renderAll();
}

/** Reads a dragged/scaled/rotated object back out in model terms. The inverse
 *  of the placement in imageObject, and the only place that inverse exists. */
export function readBack(obj: Tagged, tileCount: number, index: number) {
  const box =
    obj.space === "grid"
      ? { ...gridSize(tileCount), x: 0, y: 0 }
      : { w: TILE_W, h: TILE_H, ...cellAt(index) };
  return {
    x: ((obj.left ?? 0) - box.x) / box.w,
    y: ((obj.top ?? 0) - box.y) / box.h,
    scale: obj.getScaledWidth() / box.w,
    rotation: obj.angle ?? 0,
  };
}
