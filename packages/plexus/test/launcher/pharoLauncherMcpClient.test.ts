import { describe, expect, it } from "vitest";
import {
  parseToolTextResult,
  pharoLauncherMcpChildEnvironment,
} from "../../src/launcher/pharoLauncherMcpClient.js";

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

describe("pharo-launcher-mcp tool failures", () => {
  function failure(payload: unknown): Error {
    try {
      parseToolTextResult("pharo_launcher_image_copy_between_profiles", {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        isError: true,
      });
    } catch (error) {
      return error as Error;
    }

    throw new Error("The failed tool result was accepted");
  }

  it("reports what the launcher said went wrong", () => {
    expect(
      failure({
        ok: false,
        message:
          "Cannot copy image 'Base' in profile 'home' to 'Task' in profile 'project':"
          + " Destination image already exists at /images/Task.",
      }).message,
    ).toBe(
      "pharo-launcher-mcp tool failed: pharo_launcher_image_copy_between_profiles:"
      + " Cannot copy image 'Base' in profile 'home' to 'Task' in profile 'project':"
      + " Destination image already exists at /images/Task.",
    );
  });

  it("falls back to the diagnostic and the action a command answers with", () => {
    expect(
      failure({ ok: false, diagnostic: "Image not found.", action: "Create it first." }).message,
    ).toContain("Image not found. Create it first.");
  });

  it("keeps a launcher log out of the message", () => {
    const message = failure({ ok: false, diagnostic: "x".repeat(4_000) }).message;

    expect(message.length).toBeLessThan(600);
    expect(message.endsWith("…")).toBe(true);
  });

  it("still names the tool when the launcher explains nothing", () => {
    expect(failure({ ok: false }).message).toBe(
      "pharo-launcher-mcp tool failed: pharo_launcher_image_copy_between_profiles",
    );
  });
});
