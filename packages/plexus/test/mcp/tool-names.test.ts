import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { imageTools } from "../../src/mcp/server.js";

const sources = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), "src");

/** Every piece of text a file writes: its string literals and the text of its templates. */
function stringsOf(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("the tools the texts name", () => {
  it("are the image tools the server serves", () => {
    const served = new Set(imageTools.map((tool) => tool.name));
    const named = new Map<string, string>();
    for (const directory of ["images", "answers", "mcp"]) {
      for (const entry of fs.readdirSync(path.join(sources, directory))) {
        if (!entry.endsWith(".ts")) {
          continue;
        }
        const file = path.join(sources, directory, entry);
        for (const text of stringsOf(file)) {
          for (const [tool] of text.matchAll(/image_[a-z]+/g)) {
            named.set(tool, path.relative(sources, file));
          }
        }
      }
    }

    expect(named.size).toBeGreaterThan(0);
    expect([...named].filter(([tool]) => !served.has(tool))).toEqual([]);
  });
});
