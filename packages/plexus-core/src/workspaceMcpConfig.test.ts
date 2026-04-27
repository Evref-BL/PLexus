import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "./projectConfig.js";
import {
  buildPlexusWorkspaceMcpConfig,
  buildPharoLauncherMcpServerConfig,
  buildPharoMcpServerConfig,
  mergeWorkspaceMcpServers,
  resolvePlexusWorkspaceMcpScope,
} from "./workspaceMcpConfig.js";

const projectConfig: ProjectConfig = {
  name: "my-project",
  kanban: {
    provider: "vibe-kanban",
    projectId: "project-123",
  },
  images: [
    {
      id: "dev",
      imageName: "MyProject-{workspaceId}-dev",
      active: true,
      mcp: {
        loadScript: "pharo/load-mcp.st",
      },
    },
  ],
};

const pharoEvalTool: Tool = {
  name: "pharo_eval",
  description: "Evaluate Smalltalk code.",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string" },
    },
    required: ["code"],
  },
};

describe("workspace MCP config", () => {
  it("resolves the workspace scope from project config and caller overrides", () => {
    expect(
      resolvePlexusWorkspaceMcpScope({
        projectRoot: "C:\\dev\\code\\git\\Project-worktree",
        projectConfig,
        workspaceId: "task-123",
        stateRoot: "C:\\dev\\code\\git\\.plexus-state",
      }),
    ).toEqual({
      projectRoot: path.resolve("C:\\dev\\code\\git\\Project-worktree"),
      projectId: "project-123",
      workspaceId: "task-123",
      targetId: "project-123--task-123",
      stateRoot: path.resolve("C:\\dev\\code\\git\\.plexus-state"),
    });
  });

  it("builds a scoped pharo-launcher server entry without raw host-wide pharo-launcher-mcp access", () => {
    expect(
      buildPharoLauncherMcpServerConfig({
        projectRoot: "C:\\dev\\code\\git\\Project-worktree",
        projectConfig,
        workspaceId: "task-123",
        targetId: "target-123",
        stateRoot: "C:\\dev\\code\\git\\.plexus-state",
        plexusCommand: "plexus",
        pharoTools: [pharoEvalTool],
      }),
    ).toEqual({
      command: "plexus",
      args: ["mcp", "pharo-launcher"],
      env: {
        PLEXUS_AGENT_MCP_SURFACE: "pharo-launcher",
        PLEXUS_PROJECT_ROOT: path.resolve("C:\\dev\\code\\git\\Project-worktree"),
        PLEXUS_PROJECT_ID: "project-123",
        PLEXUS_WORKSPACE_ID: "task-123",
        VIBE_KANBAN_WORKSPACE_ID: "task-123",
        PLEXUS_TARGET_ID: "target-123",
        PLEXUS_STATE_ROOT: path.resolve("C:\\dev\\code\\git\\.plexus-state"),
      },
    });
  });

  it("builds a scoped pharo facade server entry with the project tool contract", () => {
    const server = buildPharoMcpServerConfig({
      projectRoot: "C:\\dev\\code\\git\\Project-worktree",
      projectConfig,
      workspaceId: "task-123",
      targetId: "target-123",
      stateRoot: "C:\\dev\\code\\git\\.plexus-state",
      plexusGatewayCommand: "plexus-gateway",
      pharoTools: [pharoEvalTool],
      pharoMcpContract: {
        id: "project-contract",
        hash: "sha256:expected",
      },
    });

    expect(server).toMatchObject({
      command: "plexus-gateway",
      args: ["--stdio"],
      env: {
        PLEXUS_GATEWAY_SURFACE: "pharo",
        PLEXUS_PROJECT_ROOT: path.resolve("C:\\dev\\code\\git\\Project-worktree"),
        PLEXUS_PROJECT_ID: "project-123",
        PLEXUS_WORKSPACE_ID: "task-123",
        VIBE_KANBAN_WORKSPACE_ID: "task-123",
        PLEXUS_TARGET_ID: "target-123",
        PLEXUS_STATE_ROOT: path.resolve("C:\\dev\\code\\git\\.plexus-state"),
        PLEXUS_PHARO_MCP_CONTRACT_JSON: JSON.stringify({
          id: "project-contract",
          hash: "sha256:expected",
        }),
      },
    });
    expect(JSON.parse(server.env?.PLEXUS_PHARO_TOOLS_JSON ?? "")).toEqual([
      pharoEvalTool,
    ]);
  });

  it("merges generated MCP servers without dropping unrelated entries", () => {
    expect(
      buildPlexusWorkspaceMcpConfig({
        projectRoot: "C:\\dev\\code\\git\\Project-worktree",
        projectConfig,
        workspaceId: "task-123",
        pharoTools: [pharoEvalTool],
        existingServers: {
          existing: {
            command: "node",
            args: ["existing.js"],
          },
        },
      }).servers,
    ).toMatchObject({
      existing: {
        command: "node",
        args: ["existing.js"],
      },
      "pharo-launcher": {
        env: {
          PLEXUS_AGENT_MCP_SURFACE: "pharo-launcher",
          PLEXUS_WORKSPACE_ID: "task-123",
        },
      },
      pharo: {
        env: {
          PLEXUS_GATEWAY_SURFACE: "pharo",
          PLEXUS_WORKSPACE_ID: "task-123",
        },
      },
    });
  });

  it("lets generated servers replace only their managed names", () => {
    expect(
      mergeWorkspaceMcpServers(
        {
          pharo: {
            command: "old-pharo",
            args: [],
          },
          unrelated: {
            command: "keep",
            args: [],
          },
        },
        {
          pharo: {
            command: "new-pharo",
            args: ["--stdio"],
          },
        },
      ),
    ).toEqual({
      pharo: {
        command: "new-pharo",
        args: ["--stdio"],
      },
      unrelated: {
        command: "keep",
        args: [],
      },
    });
  });
});
