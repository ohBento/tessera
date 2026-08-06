import { svelte } from "@sveltejs/vite-plugin-svelte";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/* Two projects, because the suite has two genuinely different needs:
 * "unit" is pure data and runs in Node, "browser" renders through Fabric and
 * needs a real canvas. Keeping them apart means the fast tests stay fast. */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.browser.test.ts"],
        },
      },
      {
        /* The svelte plugin lives here rather than at the top so the Node
         * project stays plugin-free and fast. It is what lets a test mount a
         * real component: together with platform.ts picking its in-memory
         * filesystem outside Tauri, the whole app runs in this project — which
         * is the only way to cover the parts that only break when clicked. */
        plugins: [svelte()],
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
