import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  describePharoLauncherMcpProfile,
  pharoLauncherMcpProfileEnvironment,
} from "./pharoLauncherProfile.js";
import { parseProjectConfig } from "./projectConfig.js";

function projectConfig(runtime: Record<string, unknown> = {}) {
  return parseProjectConfig({
    name: "my-project",
    kanban: {
      provider: "vibe-kanban",
      projectId: "project-123",
    },
    runtime,
    images: [],
  });
}

describe("pharo-launcher-mcp profile derivation", () => {
  it("derives a project-owned launcher profile from project workspace and target scope", () => {
    const projectRoot = path.join(path.sep, "tmp", "my-project");
    const stateRoot = path.join(path.sep, "tmp", "plexus-state");
    const env = pharoLauncherMcpProfileEnvironment({
      projectRoot,
      config: projectConfig(),
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      stateRoot,
    });

    const profileRoot = path.join(
      stateRoot,
      "profiles",
      "pharo-launcher-mcp",
      "project-123",
      "worktree-a",
      "project-123--worktree-a",
    );
    expect(env).toEqual({
      PHARO_LAUNCHER_MCP_PROFILE:
        "plexus-project-123-worktree-a-project-123--worktree-a",
      PHARO_LAUNCHER_MCP_STATE_ROOT: profileRoot,
      PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE: path.join(
        profileRoot,
        "launcher",
        "PharoLauncher.image",
      ),
      PHARO_LAUNCHER_MCP_IMAGES_DIR: path.join(profileRoot, "images"),
      PHARO_LAUNCHER_MCP_VMS_DIR: path.join(profileRoot, "vms"),
      PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR: path.join(
        profileRoot,
        "templates",
      ),
      PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR: path.join(
        profileRoot,
        "init-scripts",
      ),
      PHARO_LAUNCHER_MCP_LOGS_DIR: path.join(profileRoot, "logs"),
      PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION: path.join(
        profileRoot,
        "launcher",
        "pharo-launcher-cli-config.ston",
      ),
    });
  });

  it("supports explicit project-owned profile name and root overrides", () => {
    const profileRoot = path.join(path.sep, "profiles", "custom-launcher");
    const diagnostic = describePharoLauncherMcpProfile({
      projectRoot: path.join(path.sep, "tmp", "my-project"),
      config: projectConfig({
        launcherProfile: {
          mode: "project-owned",
          name: "custom-profile",
          root: profileRoot,
        },
      }),
      workspaceId: "worktree-a",
      targetId: "target-a",
    });

    expect(diagnostic).toMatchObject({
      ownership: "plexus-owned",
      mode: "project-owned",
      profileName: "custom-profile",
      stateRoot: profileRoot,
      imagesDir: path.join(profileRoot, "images"),
    });
  });

  it("reports externally supplied launcher profile environment only when configured external", () => {
    const diagnostic = describePharoLauncherMcpProfile({
      projectRoot: path.join(path.sep, "tmp", "my-project"),
      config: projectConfig({
        launcherProfile: {
          mode: "external",
        },
      }),
      workspaceId: "worktree-a",
      targetId: "target-a",
      env: {
        PHARO_LAUNCHER_MCP_PROFILE: "user-profile",
        PHARO_LAUNCHER_MCP_STATE_ROOT: path.join(path.sep, "user", "profile"),
      },
    });

    expect(diagnostic).toMatchObject({
      ownership: "external",
      mode: "external",
      profileName: "user-profile",
      stateRoot: path.join(path.sep, "user", "profile"),
      environmentKeys: [
        "PHARO_LAUNCHER_MCP_PROFILE",
        "PHARO_LAUNCHER_MCP_STATE_ROOT",
      ],
    });
  });

  it("reports unknown profile scope when external mode has no profile environment", () => {
    const diagnostic = describePharoLauncherMcpProfile({
      projectRoot: path.join(path.sep, "tmp", "my-project"),
      config: projectConfig({
        launcherProfile: {
          mode: "external",
        },
      }),
      workspaceId: "worktree-a",
      targetId: "target-a",
      env: {},
    });

    expect(diagnostic).toMatchObject({
      ownership: "unknown",
      mode: "external",
      environmentKeys: [],
    });
  });
});
