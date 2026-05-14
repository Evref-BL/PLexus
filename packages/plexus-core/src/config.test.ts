import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadPharoLauncherMcpConfig,
  pharoLauncherMcpCommandName,
  pharoLauncherMcpPackageName,
} from "./config.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("loadPharoLauncherMcpConfig", () => {
  it("uses explicit environment variables", () => {
    const config = loadPharoLauncherMcpConfig({
      PHARO_LAUNCHER_MCP_REPO_DIR: "C:\\dev\\code\\git\\pharo-launcher-mcp",
      PHARO_LAUNCHER_MCP_COMMAND: "node",
      PHARO_LAUNCHER_MCP_ENTRY: "C:\\dev\\code\\git\\pharo-launcher-mcp\\dist\\index.js",
    });

    expect(config).toEqual({
      source: "env",
      repoDir: "C:\\dev\\code\\git\\pharo-launcher-mcp",
      entry: "C:\\dev\\code\\git\\pharo-launcher-mcp\\dist\\index.js",
      command: "node",
      args: ["C:\\dev\\code\\git\\pharo-launcher-mcp\\dist\\index.js"],
    });
  });

  it.each([
    [
      "Windows",
      "C:\\dev\\code\\git\\pharo-launcher-mcp",
      "C:\\dev\\code\\git\\pharo-launcher-mcp\\dist\\index.js",
    ],
    ["POSIX", "/opt/pharo-launcher-mcp", "/opt/pharo-launcher-mcp/dist/index.js"],
  ])("derives the pharo-launcher-mcp entry from a %s repo path", (_, repoDir, entry) => {
    const config = loadPharoLauncherMcpConfig({
      PHARO_LAUNCHER_MCP_REPO_DIR: repoDir,
      PHARO_LAUNCHER_MCP_COMMAND: "node",
    });

    expect(config).toEqual({
      source: "env",
      repoDir,
      entry,
      command: "node",
      args: [entry],
    });
  });

  it("resolves the installed pharo-launcher-mcp package by default", () => {
    const installedEntry =
      "C:\\dev\\code\\app\\node_modules\\@evref-bl\\pharo-launcher-mcp\\dist\\index.js";
    const config = loadPharoLauncherMcpConfig(
      {},
      {
        resolveInstalledEntry: () => installedEntry,
      },
    );

    expect(config.source).toBe("package");
    expect(config.command).toBe(process.execPath);
    expect(config.args).toHaveLength(1);
    expect(config.args[0]).toBe(installedEntry);
    expect(config.args[0]).toMatch(/dist[\\/]+index\.js$/);
    expect(config.entry).toBe(config.args[0]);
    expect(config.packageDir?.toLowerCase()).toContain("pharo-launcher-mcp");
  });

  it("falls back to the pharo-launcher-mcp command when the package is unavailable", () => {
    const config = loadPharoLauncherMcpConfig(
      {},
      {
        resolveInstalledEntry: () => undefined,
      },
    );

    expect(config).toEqual({
      source: "command",
      command: "pharo-launcher-mcp",
      args: [],
    });
  });

  it("supports an explicit pharo-launcher-mcp command override", () => {
    const config = loadPharoLauncherMcpConfig({
      PHARO_LAUNCHER_MCP_COMMAND: "pharo-launcher-mcp",
    });

    expect(config).toMatchObject({
      source: "env",
      command: "pharo-launcher-mcp",
      args: [],
    });
  });

  it("keeps the Pharo Launcher MCP dependency on the pharo-launcher-mcp project", () => {
    expect(pharoLauncherMcpPackageName).toBe("@evref-bl/pharo-launcher-mcp");
    expect(pharoLauncherMcpCommandName).toBe("pharo-launcher-mcp");

    const corePackage = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "packages", "plexus-core", "package.json"),
        "utf8",
      ),
    ) as {
      dependencies?: Record<string, string>;
    };
    expect(corePackage.dependencies).toHaveProperty(pharoLauncherMcpPackageName);
    expect(corePackage.dependencies).not.toHaveProperty("@evref-bl/mcp-pl");

    const lockfile = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, unknown>;
    };
    expect(lockfile.packages).toHaveProperty(
      `node_modules/${pharoLauncherMcpPackageName}`,
    );
    expect(lockfile.packages).not.toHaveProperty("packages/pharo-launcher-mcp");

    const serializedLockfile = JSON.stringify(lockfile);
    expect(serializedLockfile).not.toContain("@evref-bl/mcp-pl");
    expect(serializedLockfile).not.toContain("@plexus/pharo-launcher-mcp");
  });
});
