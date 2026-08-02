import { describe, expect, it } from "vitest";
import de from "./de.json";
import en from "./en.json";

/* Without this, a new feature adds a key to en.json only, nobody notices, and a
 * German user eventually stares at an empty button. */
describe("locales", () => {
  it("all have the same keys as en", () => {
    for (const [name, dict] of Object.entries({ de })) {
      expect({ [name]: Object.keys(dict).sort() }).toEqual({ [name]: Object.keys(en).sort() });
    }
  });
});
