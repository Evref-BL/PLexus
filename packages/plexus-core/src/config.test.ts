import { describe, expect, it } from "vitest";
import { loadMcpPlConfig } from "./config.js";

describe("loadMcpPlConfig", () => {
  it("uses explicit environment variables", () => {
    const config = loadMcpPlConfig({
      MCP_PL_REPO_DIR: "C:\\dev\\code\\git\\MCP-PL",
      MCP_PL_COMMAND: "node",
      MCP_PL_ENTRY: "C:\\dev\\code\\git\\MCP-PL\\dist\\index.js",
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
    ["POSIX", "/opt/mcp-pl", "/opt/mcp-pl/dist/index.js"],
  ])("derives the MCP-PL entry from a %s repo path", (_, repoDir, entry) => {
    const config = loadMcpPlConfig({
      MCP_PL_REPO_DIR: repoDir,
      MCP_PL_COMMAND: "node",
    });

    expect(config).toEqual({
      source: "env",
      repoDir,
      entry,
      command: "node",
      args: [entry],
    });
  });

  it("resolves the installed MCP-PL package by default", () => {
    const config = loadMcpPlConfig({});

    expect(config.source).toBe("package");
    expect(config.command).toBe(process.execPath);
    expect(config.args).toHaveLength(1);
    expect(config.args[0]?.toLowerCase()).toContain("mcp-pl");
    expect(config.args[0]).toMatch(/dist[\\/]+index\.js$/);
    expect(config.entry).toBe(config.args[0]);
    expect(config.packageDir?.toLowerCase()).toContain("mcp-pl");
  });

  it("supports an explicit mcp-pl command override", () => {
    const config = loadMcpPlConfig({
      MCP_PL_COMMAND: "mcp-pl",
    });

    expect(config).toMatchObject({
      source: "env",
      command: "mcp-pl",
      args: [],
    });
  });
});
