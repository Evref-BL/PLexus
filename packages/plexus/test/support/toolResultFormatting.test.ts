import { describe, expect, it } from "vitest";
import {
  formatToolResultPayload,
  toolResultDetailFromArguments,
} from "../../src/support/toolResultFormatting.js";

describe("tool result formatting", () => {
  it("keeps every row of a list, however long", () => {
    // The regression this guards: `summary` used to keep ten items and report
    // the rest as `omittedCount`, so `template_list` answered with ten of the
    // thirty templates a caller had to choose from.
    const templates = Array.from({ length: 30 }, (_, index) => ({
      name: `Pharo ${index}.0 - 64bit`,
      templateCategory: "Official distributions",
    }));

    const summary = formatToolResultPayload({ templates }, "summary") as {
      templates: unknown[];
    };

    expect(summary.templates).toHaveLength(30);
    expect(summary.templates).toEqual(templates);
  });

  it("compacts what is inside a row", () => {
    const payload = {
      images: [{ raw: { stdout: "x".repeat(2_000) } }],
    };

    const summary = formatToolResultPayload(payload, "summary") as {
      images: { raw: { stdout: Record<string, unknown> } }[];
    };

    expect(summary.images).toHaveLength(1);
    expect(summary.images[0].raw.stdout).toMatchObject({
      kind: "truncated-text",
      length: 2_000,
    });
  });

  it("summarizes an object past the depth a caller reads", () => {
    const deep = { a: { b: { c: { d: { e: 1, f: 2 } } } } };

    expect(formatToolResultPayload(deep, "summary")).toEqual({
      a: { b: { c: { d: { kind: "object-summary", fieldCount: 2 } } } },
    });
  });

  it("leaves everything alone at full detail", () => {
    const payload = { text: "y".repeat(2_000), deep: { a: { b: { c: { d: 1 } } } } };

    expect(formatToolResultPayload(payload, "full")).toEqual(payload);
  });

  it("reads the detail level, defaulting to summary", () => {
    expect(toolResultDetailFromArguments({ detail: "full" })).toBe("full");
    expect(toolResultDetailFromArguments({ detail: "summary" })).toBe("summary");
    expect(toolResultDetailFromArguments({})).toBe("summary");
    expect(toolResultDetailFromArguments(undefined)).toBe("summary");
  });
});
