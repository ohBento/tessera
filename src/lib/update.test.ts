import { describe, expect, it } from "vitest";
import { isNewer } from "./update";

describe("isNewer", () => {
  it("compares numerically, not as text", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true); // "0.10" < "0.9" as strings
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
  });

  it("ignores a leading v", () => {
    expect(isNewer("v1.1.0", "1.0.0")).toBe(true);
  });

  it("treats missing fields as zero", () => {
    expect(isNewer("1.2.1", "1.2")).toBe(true);
    expect(isNewer("1.2", "1.2.0")).toBe(false);
  });

  it("is false for the same version", () => {
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  });
});
