import { describe, expect, it } from "vitest";
import { pharoLauncherMcpChildEnvironment } from "./pharoLauncherMcpClient.js";

describe("pharo-launcher-mcp child environment", () => {
  it("forwards launcher environment and filters unrelated variables", () => {
    expect(
      pharoLauncherMcpChildEnvironment({
        env: {
          PHARO_LAUNCHER_DIR: "/opt/pharo-launcher",
          PHARO_LAUNCHER_MCP_PROFILE: "host-profile",
          PATH: "/usr/bin",
        },
      }),
    ).toEqual({
      PHARO_LAUNCHER_DIR: "/opt/pharo-launcher",
      PHARO_LAUNCHER_MCP_PROFILE: "host-profile",
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
