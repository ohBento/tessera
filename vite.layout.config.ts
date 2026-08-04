import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Serves layout-check.html with lib/project.ts swapped for mockAppProject.ts,
 *  so the full App.svelte can mount and reach a populated TileEditor without a
 *  Tauri shell — for checking real editor-pane widths in a plain browser. Same
 *  swap technique as vite.harness.config.ts. Scratch: delete this file,
 *  layout-check.html, and src/harness/{layoutMain,mockAppProject}.ts once the
 *  editor-pane width bug is confirmed fixed.
 *
 *  Run with: npx vite --config vite.layout.config.ts */

const real = fileURLToPath(new URL("./src/lib/project.ts", import.meta.url));
const mock = fileURLToPath(new URL("./src/harness/mockAppProject.ts", import.meta.url));

const same = (a: string, b: string) =>
  path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

export default defineConfig({
  clearScreen: false,
  server: { port: 1422, strictPort: true },
  plugins: [
    svelte(),
    {
      name: "layout-mock-project",
      enforce: "pre",
      async resolveId(source, importer, options) {
        if (!importer || source.includes("harness/")) return null;
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (resolved && same(resolved.id.split("?")[0], real)) return mock;
        return null;
      },
    },
  ],
});
