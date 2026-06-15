import { describe, expect, it } from "vitest";
import { pharoLauncherMcpChildEnvironment } from "../../src/launcher/pharoLauncherMcpClient.js";

describe("pharo-launcher-mcp child environment", () => {
  it("forwards launcher environment, execution path, and filters unrelated variables", () => {
    expect(
      pharoLauncherMcpChildEnvironment({
        env: {
          PHARO_LAUNCHER_DIR: "/opt/pharo-launcher",
          PHARO_LAUNCHER_MCP_PROFILE: "host-profile",
          PATH: "/bin:/usr/bin",
          npm_config_cache: "/tmp/npm-cache",
        },
      }),
    ).toEqual({
      PHARO_LAUNCHER_DIR: "/opt/pharo-launcher",
      PHARO_LAUNCHER_MCP_PROFILE: "host-profile",
      PATH: "/bin:/usr/bin",
    });
  });

  it("forwards Windows path casing for command-shell lookup", () => {
    expect(
      pharoLauncherMcpChildEnvironment({
        env: {
          PHARO_LAUNCHER_DIR: "C:\\PharoLauncher",
          Path: "C:\\Windows\\System32",
        },
      }),
    ).toEqual({
      PHARO_LAUNCHER_DIR: "C:\\PharoLauncher",
      Path: "C:\\Windows\\System32",
    });
  });

  it("lets PLexus-owned profile environment override host profile variables", () => {
    expect(
      pharoLauncherMcpChildEnvironment({
        env: {
          PHARO_LAUNCHER_MCP_PROFILE: "host-profile",
          PHARO_LAUNCHER_MCP_STATE_ROOT: "/host/profile",
        },
        profileEnvironment: {
          PHARO_LAUNCHER_MCP_PROFILE: "plexus-profile",
          PHARO_LAUNCHER_MCP_STATE_ROOT: "/plexus/profile",
        },
      }),
    ).toMatchObject({
      PHARO_LAUNCHER_MCP_PROFILE: "plexus-profile",
      PHARO_LAUNCHER_MCP_STATE_ROOT: "/plexus/profile",
    });
  });
});
