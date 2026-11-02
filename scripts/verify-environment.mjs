#!/usr/bin/env node
/**
 * What this machine can run PLexus with.
 *
 * This replaces a PowerShell script that could only answer on Windows, and
 * answered badly there: it hardcoded one developer's home directory as the
 * launcher location, named `PharoConsole.exe`, and resolved the launcher
 * package with `require.resolve`, which returns the library export rather than
 * the bin that answers `--health`.
 *
 * None of that needs reimplementing. `loadPharoLauncherMcpConfig` is how
 * PLexus itself finds the launcher command, and `--health` is how it asks what
 * that command discovered. Asking the same way is the point: a discrepancy
 * here is a discrepancy that would break an open.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

async function main() {
  let ok = true;

  for (const command of ["node", "npm", "git"]) {
    const version = commandVersion(command);
    ok = report(command, Boolean(version), version ?? "") && ok;
  }

  const distEntry = path.join(
    repoRoot,
    "packages",
    "plexus",
    "dist",
    "internal.js",
  );
  if (!fs.existsSync(distEntry)) {
    console.log("");
    console.log("Run npm run build first: this reads the built package.");
    return 1;
  }

  const { loadPharoLauncherMcpConfig } = await import(distEntry);
  const config = loadPharoLauncherMcpConfig();

  console.log("");
  console.log(`launcher command source: ${config.source}`);
  ok =
    report(
      "pharo-launcher-mcp entry",
      config.entry === undefined || fs.existsSync(config.entry),
      config.entry ?? `${config.command} (on PATH)`,
    ) && ok;

  for (const key of [
    "PHARO_LAUNCHER_MCP_ENTRY",
    "PHARO_LAUNCHER_MCP_REPO_DIR",
    "PHARO_LAUNCHER_MCP_COMMAND",
    "PHARO_LAUNCHER_DIR",
    "PHARO_LAUNCHER_IMAGE",
  ]) {
    const value = process.env[key];
    if (value !== undefined) {
      ok = report(`${key} override`, fs.existsSync(value), value) && ok;
    }
  }

  // The launcher's own answer, rather than this script guessing where a
  // launcher lives on this platform. It knows; it is the thing that looks.
  const health = spawnSync(config.command, [...config.args, "--health"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (health.status !== 0 || !health.stdout.trim()) {
    ok = report(
      "pharo-launcher-mcp --health",
      false,
      health.stderr?.trim().split("\n")[0] ?? "no output",
    );
  } else {
    let discovery;
    try {
      const parsed = JSON.parse(health.stdout);
      discovery = parsed.health?.config ?? parsed.config;
    } catch {
      discovery = undefined;
    }
    ok =
      report(
        "pharo-launcher-mcp --health",
        Boolean(discovery),
        discovery?.discovery?.source ?? "answered, but not as JSON",
      ) && ok;
    for (const [label, status] of [
      ["launcher directory", discovery?.launcherDir],
      ["launcher vm", discovery?.launcherVm],
      ["launcher image", discovery?.launcherImage],
    ]) {
      if (status) {
        ok = report(label, status.exists === true, status.path ?? "") && ok;
      }
    }
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
