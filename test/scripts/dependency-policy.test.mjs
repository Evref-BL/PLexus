import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");
const manifests = [
  "package.json",
  "packages/plexus-core/package.json",
];

function dependenciesOf(file) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  return { ...manifest.dependencies };
}

test("every component of the stack is pinned to one released version", () => {
  // Nothing publishes a lockfile, and the documented install is npx, so a
  // range on a component of our own is resolved fresh on every user's machine:
  // a patch release would reach them with no release anywhere in the chain.
  for (const file of manifests) {
    for (const [name, range] of Object.entries(dependenciesOf(file))) {
      if (!name.startsWith("@evref-bl/")) continue;
      assert.match(
        range,
        /^\d+\.\d+\.\d+$/,
        `${file} depends on ${name} through the range ${range}; pin one released version.`,
      );
    }
  }
});
