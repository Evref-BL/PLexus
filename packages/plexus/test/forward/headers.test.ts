import { describe, expect, it } from "vitest";
import { annotationProblem, headerValue, parameterHeaders } from "../../src/forward/headers.js";

describe("a mirrored header value", () => {
  it("is the value when it is plain ASCII, and the Base64 sentinel otherwise, as the binding's examples say", () => {
    expect(headerValue("us-west1")).toBe("us-west1");
    expect(headerValue("a b\tc")).toBe("a b\tc");
    expect(headerValue("Hello, 世界")).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
    expect(headerValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
    expect(headerValue("line1\nline2")).toBe("=?base64?bGluZTEKbGluZTI=?=");
    expect(headerValue("=?base64?literal?=")).toBe("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
    expect(headerValue("")).toBe("=?base64??=");
  });
});

describe("x-mcp-header annotations", () => {
  const schema = (properties: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
    type: "object",
    properties,
    ...rest,
  });

  it("keep the rules on primitive properties reached through properties alone", () => {
    expect(annotationProblem(schema({ query: { type: "string" } }))).toBeUndefined();
    expect(
      annotationProblem(
        schema({
          region: { type: "string", "x-mcp-header": "Region" },
          nested: { type: "object", properties: { count: { type: "integer", "x-mcp-header": "Count" } } },
          "x-mcp-header": { type: "string" },
        }),
      ),
    ).toBeUndefined();
  });

  it("break them on a number, an invalid or repeated name, or a place no properties chain reaches", () => {
    expect(annotationProblem(schema({ at: { type: "number", "x-mcp-header": "At" } }))).toContain("at is not a string");
    expect(annotationProblem(schema({ at: { type: "string", "x-mcp-header": "" } }))).toContain("names no valid header");
    expect(annotationProblem(schema({ at: { type: "string", "x-mcp-header": "A B" } }))).toContain("names no valid header");
    expect(
      annotationProblem(schema({ a: { type: "string", "x-mcp-header": "Name" }, b: { type: "string", "x-mcp-header": "name" } })),
    ).toContain("repeats header name");
    expect(
      annotationProblem(schema({ list: { type: "array", items: { type: "string", "x-mcp-header": "Item" } } })),
    ).toContain("not reached through properties alone");
    expect(
      annotationProblem(schema({}, { oneOf: [{ properties: { a: { type: "string", "x-mcp-header": "A" } } }] })),
    ).toContain("not reached through properties alone");
  });

  it("mirror the strings, booleans and safe integers a call gives, and nothing for a schema that breaks them", () => {
    const annotated = schema({
      region: { type: "string", "x-mcp-header": "Region" },
      dry: { type: "boolean", "x-mcp-header": "Dry" },
      count: { type: "integer", "x-mcp-header": "Count" },
    });
    expect(parameterHeaders(annotated, { region: "café", dry: false, count: 42 })).toEqual({
      "Mcp-Param-Region": "=?base64?Y2Fmw6k=?=",
      "Mcp-Param-Dry": "false",
      "Mcp-Param-Count": "42",
    });
    expect(parameterHeaders(annotated, { count: 2 ** 53, region: ["us"], dry: null })).toEqual({});
    expect(parameterHeaders(schema({ at: { type: "number", "x-mcp-header": "At" } }), { at: 1 })).toEqual({});
  });
});
