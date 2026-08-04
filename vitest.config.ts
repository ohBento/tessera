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
