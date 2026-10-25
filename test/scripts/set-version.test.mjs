import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setVersion, versionedManifests } from "../../scripts/set-version.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");

function temporaryWorkspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-version-"));
  for (const file of versionedManifests) {
    fs.mkdirSync(path.join(directory, path.dirname(file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  return directory;
}

test("every published workspace moves to the same version", () => {
  const directory = temporaryWorkspace();
  try {
    setVersion("9.8.7", { cwd: directory });

    for (const file of versionedManifests) {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
      assert.equal(manifest.version, "9.8.7", `${file} was not moved`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a version the release workflow would reject is refused here first", () => {
  const directory = temporaryWorkspace();
  try {
    for (const rejected of ["1.2", "v1.2.3", "1.2.3-rc.1", undefined]) {
      assert.throws(() => setVersion(rejected, { cwd: directory }), /release SemVer/);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the published workspaces agree on a version right now", () => {
  const versions = versionedManifests.map(
    (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).version,
  );

  assert.equal(new Set(versions).size, 1, `Manifests disagree: ${versions.join(", ")}`);
});
