#!/usr/bin/env node
/**
 * What this machine can run PLexus with.
 *
 * The launcher answers where it found Pharo Launcher the same way it finds it
 * when PLexus calls it, so a discrepancy here is one that would break a
 * create.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openPharoLauncher } from "@evref-bl/pharo-launcher-mcp/launcher";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function report(name, ok, detail = "") {
  const status = ok ? "OK" : "MISSING";
  console.log(`${name.padEnd(34)} ${status}${detail ? `  ${detail}` : ""}`);
  return ok;
}

function commandVersion(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return result.status === 0 ? result.stdout.trim().split("\n")[0] : undefined;
}

async function main() {
  let ok = true;

  for (const command of ["node", "npm", "git"]) {
    const version = commandVersion(command);
    ok = report(command, Boolean(version), version ?? "") && ok;
  }

  const distEntry = path.join(repoRoot, "packages", "plexus", "dist", "index.js");
  if (!fs.existsSync(distEntry)) {
    console.log("");
    console.log("Run npm run build first: this reads the built package.");
    return 1;
  }
  const { plexusHome } = await import(distEntry);
  console.log("");
  console.log(`PLexus home: ${plexusHome()}`);

  const config = openPharoLauncher().describeConfig();
  console.log(`launcher found through: ${config.discovery.source}`);
  ok = report("launcher directory", config.launcherDir.exists, config.launcherDir.path) && ok;
  ok = report("launcher vm", config.launcherVm.exists, config.launcherVm.path) && ok;
  ok = report(
    "launcher image",
    config.installationLauncherImage.exists,
    config.installationLauncherImage.path,
  ) && ok;

  console.log("");
  console.log(ok ? "Environment looks usable." : "Something above is missing.");
  return ok ? 0 : 1;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
