/* Runs in a real Chromium (see vitest.config.ts): Fabric and canvas.toBlob
 * both need a DOM. */
import { describe, expect, it } from "vitest";

import { TILE_H, TILE_W } from "./bmp";
import { renderLayout } from "./layout";
import { newImageLayer, newLayout } from "./model";
import { testDeps } from "../test/images";

/** Decodes a PNG back into pixels, the same shape pixel-reading tests
 *  elsewhere use, so a rendered Layout can be checked the same way a BMP is. */
async function decode(bytes: Uint8Array) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  return { width: bmp.width, height: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
}

describe("renderLayout", () => {
  it("renders at exactly tile resolution", async () => {
    const layout = newLayout("Leer");
    const { width, height } = await decode(await renderLayout(layout, testDeps));
    expect(width).toBe(TILE_W);
    expect(height).toBe(TILE_H);
  });

  it("puts a layer's picture where its x/y says, at tile scale", async () => {
    const layout = newLayout("Ecke");
    const l = newImageLayer("block:#ff00ff");
    l.x = 0.15;
    l.y = 0.2;
    l.scale = 0.1;
    layout.layers.push(l);

    const { data, width } = await decode(await renderLayout(layout, testDeps));
    const px = (x: number, y: number) => {
      const o = (y * width + x) * 4;
      return [data[o], data[o + 1], data[o + 2], data[o + 3]];
    };

    expect(px(Math.round(l.x * TILE_W), Math.round(l.y * TILE_H))).toEqual([255, 0, 255, 255]);
    // Far corner stays untouched (transparent, since a Layout has no background).
    expect(px(TILE_W - 2, TILE_H - 2)[3]).toBe(0);
  });

  it("skips a hidden layer", async () => {
    const layout = newLayout("Versteckt");
    const l = newImageLayer("block:#ff00ff");
    l.x = 0.5;
    l.y = 0.5;
    l.scale = 0.5;
    l.hidden = true;
    layout.layers.push(l);

    const { data } = await decode(await renderLayout(layout, testDeps));
    // Nothing opaque anywhere — the whole canvas stayed blank.
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
    expect(opaque).toBe(0);
  });
});
