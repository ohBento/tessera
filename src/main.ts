import { mount } from "svelte";
import App from "./App.svelte";
/* The row vocabulary the sidebar's three lists share — see rows.css. Loaded
 * here rather than from a component so it belongs to none of them: Svelte
 * scopes a component's styles, and a shared rule kept inside one list is a
 * rule the next list has to copy. */
import "./rows.css";

/* Dev-only handle on the running app. The browser has no OS file dialog to
 * drive, so without this there is no way to get a picture into a Layout from
 * a test or from the preview pane — and the UI would stay the one part of
 * Tessera nothing can exercise. Stripped from a production build by the
 * import.meta.env.DEV guard. */
if (import.meta.env.DEV) {
  void (async () => {
    const [editor, platform, model] = await Promise.all([
      import("./lib/editor.svelte"),
      import("./lib/platform"),
      import("./lib/model"),
    ]);
    Object.assign(window, { tessera: { ...model, ...editor, ...platform } });
  })();
}

export default mount(App, { target: document.getElementById("app")! });
