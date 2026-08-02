import { describe, expect, it } from "vitest";
import config from "../../src-tauri/tauri.conf.json";

describe("window config", () => {
  /* Tauri's own schema: "Disabling it is required to use HTML5 drag and drop on
   * the frontend on Windows." Left at its default of true, the OS drag handler
   * swallows every dragstart/drop in the grid and reordering silently does
   * nothing. Guarded here because the symptom points nowhere near this file. */
  it("keeps OS drag-drop off so the grid can be reordered", () => {
    expect(config.app.windows[0].dragDropEnabled).toBe(false);
  });
});
