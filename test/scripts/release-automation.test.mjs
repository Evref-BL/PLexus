import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The release workflows read the MCP pin out of a source file with sed, and
// one of them writes it back. A file that moves takes the declaration with it
// and leaves the workflow reading a path that no longer answers — which is how
// v0.10.0 published without telling the plugin. These tests fail here instead.
const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const workflows = path.join(repoRoot, ".github", "workflows");

// The expression the workflows use, kept identical on purpose.
const declaration = /export const defaultPharoMcpVersion = "(\d+\.\d+\.\d+)";/;

function sourceFilesNamingThePin() {
  const named = new Set();
  for (const entry of fs.readdirSync(workflows)) {
    const text = fs.readFileSync(path.join(workflows, entry), "utf8");
    for (const match of text.matchAll(/packages\/plexus\/src\/[\w/.-]+\.ts/g)) {
      if (text.includes("defaultPharoMcpVersion")) named.add(match[0]);
    }
  }
  return [...named];
}

test("every source file the release workflows read the MCP pin from declares it", () => {
  const named = sourceFilesNamingThePin();
  assert.ok(named.length > 0, "no workflow names a pin file any more");
  for (const relative of named) {
    const file = path.join(repoRoot, relative);
    assert.ok(fs.existsSync(file), `${relative} does not exist`);
    assert.match(fs.readFileSync(file, "utf8"), declaration,
      `${relative} does not declare defaultPharoMcpVersion`);
  }
});

test("the MCP pin is declared once, so the workflows cannot read a stale copy", () => {
  const source = path.join(repoRoot, "packages", "plexus", "src");
  const declaring = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && declaration.test(fs.readFileSync(full, "utf8")))
        declaring.push(path.relative(repoRoot, full));
    }
  };
  walk(source);
  assert.deepEqual(declaring.length, 1, `declared in: ${declaring.join(", ")}`);
});
