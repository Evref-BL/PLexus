#!/usr/bin/env node
/**
 * What this machine can run PLexus with.
 *
 * The launcher's `--health` finds Pharo Launcher as its library does when
 * PLexus calls it, once the PHARO_LAUNCHER_* variables, which the library
 * never reads, are left out. So a discrepancy here is one that would break a
 * create.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function launcherHealth() {
  const manifest = createRequire(import.meta.url).resolve("@evref-bl/pharo-launcher-mcp/package.json");
  const { bin } = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("PHARO_LAUNCHER_")),
  );
  const result = spawnSync(
    process.execPath,
    [path.join(path.dirname(manifest), bin["pharo-launcher-mcp"]), "--health"],
    { encoding: "utf8", env },
  );
  return { ok: result.status === 0, report: `${result.stdout}${result.stderr}`.trim() };
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

  const health = launcherHealth();
  ok = report("pharo launcher", health.ok) && ok;
  if (!health.ok) {
    console.log(health.report);
  }

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
