import { describe, expect, it } from "vitest";
import { loadPharoLauncherMcpConfig } from "./config.js";

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
});
