import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Serves harness.html with lib/project.ts swapped for a browser-only mock, so
 *  render.ts and fabricBuild.ts can run without a Tauri shell. Kept as its own
 *  config on purpose: the swap must never reach the production build, where
 *  project.ts is the real filesystem layer.
 *
 *  Run with: npm run harness */

const real = fileURLToPath(new URL("./src/lib/project.ts", import.meta.url));
const mock = fileURLToPath(new URL("./src/harness/mockProject.ts", import.meta.url));

/** Matched on the *resolved* path rather than the import string: the importers
 *  all write "./project", which no path-shaped alias would catch, and matching
 *  that bare string would swap any same-named module anywhere in the tree. */
const same = (a: string, b: string) =>
  path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

export default defineConfig({
  clearScreen: false,
  server: { port: 1421, strictPort: true },
  plugins: [
    {
      name: "harness-mock-project",
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
