/** Mounts the real App.svelte behind a minimal Tauri stub, so the editor pane's
 *  CSS can be checked at real production widths in a plain browser. Scratch
 *  tool — delete alongside layout-check.html and mockAppProject.ts once the
 *  editor-pane width bug is confirmed fixed. */

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => (cmd === "system_fonts" ? ["Arial"] : null),
  convertFileSrc: (p: string) => p,
  transformCallback: () => 0,
  unregisterCallback: () => {},
};

const { mount } = await import("svelte");
const { default: App } = await import("../App.svelte");
mount(App, { target: document.getElementById("app")! });

export {};
