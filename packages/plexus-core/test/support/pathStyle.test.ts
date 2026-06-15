import { describe, expect, it } from "vitest";

import { sanitizePathSegment } from "../../src/support/pathStyle.js";

describe("sanitizePathSegment", () => {
  it("collapses unsafe path characters and trims generated separators", () => {
    expect(sanitizePathSegment(" repo path / main ", "fallback")).toBe(
      "repo-path-main",
    );
  });

  it("uses the fallback when no safe path characters remain", () => {
    expect(sanitizePathSegment(" /  ", "fallback")).toBe("fallback");
  });
});
