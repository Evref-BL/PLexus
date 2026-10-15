import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateMcpRelease } from "../../scripts/update-mcp-release.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-mcp-release-"));
  fs.mkdirSync(path.join(root, "packages/plexus-core/src/workspace"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages/plexus-core"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages/plexus-gateway"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  for (const relativePath of ["package.json", "packages/plexus-core/package.json", "packages/plexus-gateway/package.json"]) {
    const filePath = path.join(root, relativePath);
    fs.writeFileSync(filePath, `${JSON.stringify({ version: "0.1.0" }, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify({
    version: "0.1.0",
    packages: {
      "": { version: "0.1.0" },
      "packages/plexus-core": { version: "0.1.0" },
      "packages/plexus-gateway": { version: "0.1.0" },
    },
  }, null, 2)}\n`);
  fs.writeFileSync(
    path.join(root, "packages/plexus-core/src/workspace/projectStartupScript.ts"),
    'commitish: "v1.2.3"\n',
  );
  fs.writeFileSync(path.join(root, "README.md"), "MCP v1.2.3\n");
  fs.writeFileSync(path.join(root, "test/expected.txt"), "v1.2.3\n");
  return root;
}

test("updates the pinned MCP release and bumps PLexus patch version", () => {
  const root = fixture();
  try {
    assert.deepEqual(updateMcpRelease(root, "v1.3.0"), {
      changed: true,
      previous: "v1.2.3",
      tag: "v1.3.0",
      version: "0.1.1",
    });
    assert.match(fs.readFileSync(path.join(root, "README.md"), "utf8"), /v1\.3\.0/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "0.1.1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does nothing when the latest MCP release is already pinned", () => {
  const root = fixture();
  try {
    assert.deepEqual(updateMcpRelease(root, "v1.2.3"), {
      changed: false,
      current: "v1.2.3",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
