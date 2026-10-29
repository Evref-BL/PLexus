// The Release workflow cuts a tag from the version already in the manifests,
// and refuses to run unless both published workspaces carry the same one.
// Moving three files by hand is how that goes wrong, so move them together.
import fs from "node:fs";

export const versionedManifests = [
  "package.json",
  "packages/plexus/package.json",
];

export function setVersion(version, { cwd = process.cwd() } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error("Expected a release SemVer version.");
  }
  for (const file of versionedManifests) {
    const path = `${cwd}/${file}`;
    const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
    manifest.version = version;
    fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return version;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  setVersion(process.argv[2]);
  console.log("Set the version. Run npm install to refresh the lockfile.");
}
