import { describe, expect, it } from "vitest";
import { loadPharoLauncherMcpConfig } from "./config.js";

describe("loadPharoLauncherMcpConfig", () => {
  it("uses explicit environment variables", () => {
    const config = loadPharoLauncherMcpConfig({
      PHARO_LAUNCHER_MCP_REPO_DIR: "C:\\dev\\code\\git\\MCP-PL",
      PHARO_LAUNCHER_MCP_COMMAND: "node",
      PHARO_LAUNCHER_MCP_ENTRY: "C:\\dev\\code\\git\\MCP-PL\\dist\\index.js",
    });

    expect(config).toEqual({
      source: "env",
      repoDir: "C:\\dev\\code\\git\\MCP-PL",
      entry: "C:\\dev\\code\\git\\MCP-PL\\dist\\index.js",
      command: "node",
      args: ["C:\\dev\\code\\git\\MCP-PL\\dist\\index.js"],
    });
  });

  it.each([
    [
      "Windows",
      "C:\\dev\\code\\git\\MCP-PL",
      "C:\\dev\\code\\git\\MCP-PL\\dist\\index.js",
    ],
    ["POSIX", "/opt/MCP-PL", "/opt/MCP-PL/dist/index.js"],
  ])("derives the MCP-PL entry from a %s repo path", (_, repoDir, entry) => {
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

  it("resolves the installed mcp-pl package by default", () => {
    const installedEntry =
      "C:\\dev\\code\\app\\node_modules\\@evref-bl\\mcp-pl\\dist\\index.js";
    const config = loadPharoLauncherMcpConfig(
      {},
      {
        resolveInstalledEntry: (packageName) =>
          packageName === "@evref-bl/mcp-pl" ? installedEntry : undefined,
      },
    );

    expect(config.source).toBe("package");
    expect(config.command).toBe(process.execPath);
    expect(config.args).toHaveLength(1);
    expect(config.args[0]).toBe(installedEntry);
    expect(config.args[0]).toMatch(/dist[\\/]+index\.js$/);
    expect(config.entry).toBe(config.args[0]);
    expect(config.packageName).toBe("@evref-bl/mcp-pl");
    expect(config.packageDir?.toLowerCase()).toContain("mcp-pl");
  });

  it("falls back to the legacy package name when mcp-pl is unavailable", () => {
    const installedEntry =
      "C:\\dev\\code\\app\\node_modules\\@evref-bl\\pharo-launcher-mcp\\dist\\index.js";
    const config = loadPharoLauncherMcpConfig(
      {},
      {
        resolveInstalledEntry: (packageName) =>
          packageName === "@evref-bl/pharo-launcher-mcp"
            ? installedEntry
            : undefined,
      },
    );

    expect(config.source).toBe("package");
    expect(config.entry).toBe(installedEntry);
    expect(config.packageName).toBe("@evref-bl/pharo-launcher-mcp");
  });

  it("falls back to the mcp-pl command when the package is unavailable", () => {
    const config = loadPharoLauncherMcpConfig(
      {},
      {
        resolveInstalledEntry: () => undefined,
      },
    );

    expect(config).toEqual({
      source: "command",
      command: "mcp-pl",
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
