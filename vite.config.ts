import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    /* Without this, Vite's watcher walks into src-tauri/target — several
     * gigabytes of cargo output — and tries to watch a build-script exe while
     * cargo still holds it open. The resulting EBUSY arrives as an unhandled
     * 'error' event on the watcher, which takes the whole dev process down and
     * with it `tauri dev`, since Vite is its beforeDevCommand. */
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
