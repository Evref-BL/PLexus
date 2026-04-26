import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  saveProjectState,
  type PharoMcpHealthClient,
  type ProjectCloseOptions,
  type ProjectCloseResult,
  type ProjectOpenOptions,
  type ProjectOpenResult,
  type ProjectState,
} from "@plexus/core";
import { PlexusGateway, type GatewayToolResult } from "./gateway.js";
import type {
  ImageMcpRoute,
  ImageMcpToolRouter,
} from "./imageMcpRouter.js";

const tempDirs: string[] = [];

const runningState: ProjectState = {
  projectId: "project-123",
  projectName: "my-project",
  workspaceId: "worktree-a",
  targetId: "project-123--worktree-a",
  updatedAt: "2026-04-25T10:00:00.000Z",
  images: [
    {
      id: "dev",
      imageName: "MyProject-dev",
      assignedPort: 7123,
      pid: 1234,
      status: "running",
    },
    {
      id: "baseline",
      imageName: "MyProject-baseline",
      assignedPort: 7124,
      status: "stopped",
    },
  ],
};

class FakeImageRouter implements ImageMcpToolRouter {
  readonly calls: Array<{
    route: ImageMcpRoute;
    toolName: string;
    argumentsValue: Record<string, unknown>;
  }> = [];

  async callTool(
    route: ImageMcpRoute,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push({ route, toolName, argumentsValue });
    return {
      content: [{ type: "text", text: "routed" }],
    };
  }
}

class FakeHealthClient implements PharoMcpHealthClient {
  readonly ports: number[] = [];

  async check(port: number): Promise<boolean> {
    this.ports.push(port);
    return port === 7123;
  }
}

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeProjectConfig(projectRoot: string): void {
  fs.writeFileSync(
    path.join(projectRoot, "plexus.project.json"),
    JSON.stringify(
      {
        name: "my-project",
        kanban: {
          provider: "vibe-kanban",
          projectId: "project-123",
        },
        images: [
          {
            id: "dev",
            imageName: "MyProject-dev",
            active: true,
            mcp: {
              port: 7123,
              loadScript: "pharo/load-mcp.st",
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function statePath(stateRoot: string, workspaceId = "worktree-a"): string {
  return path.join(
    stateRoot,
    "projects",
    "project-123",
    "workspaces",
    workspaceId,
    "state.json",
  );
}

function data<T>(result: GatewayToolResult<T>): T {
  expect(result.ok).toBe(true);
  expect(result.data).toBeDefined();
  return result.data as T;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("PlexusGateway", () => {
  it("opens a project and registers image routes", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const stateFilePath = statePath(stateRoot);
    const gateway = new PlexusGateway({
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: stateFilePath,
        state: runningState,
        failures: [],
      }),
    });

    const openResult = await gateway.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    });
    expect(openResult.ok).toBe(true);

    const status = data(
      await gateway.handleTool("plexus_project_status", {
        projectId: "project-123",
      }),
    );

    expect(status).toMatchObject({
      projectId: "project-123",
      workspaceId: "worktree-a",
      projectRoot: path.resolve(projectRoot),
      statePath: stateFilePath,
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          port: 7123,
          pid: 1234,
          status: "running",
          health: "unknown",
        },
        {
          id: "baseline",
          imageName: "MyProject-baseline",
          port: 7124,
          status: "stopped",
          health: "unknown",
        },
      ],
    });
  });

  it("refreshes health for running image routes", async () => {
    const healthClient = new FakeHealthClient();
    const gateway = new PlexusGateway({
      healthClient,
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: runningState,
        failures: [],
      }),
    });

    await gateway.handleTool("plexus_project_open", {
      projectPath: makeTempDir("plexus-project-"),
      workspaceId: "worktree-a",
    });
    const status = data(
      await gateway.handleTool("plexus_project_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
        refreshHealth: true,
      }),
    );

    expect(healthClient.ports).toEqual([7123]);
    expect(status).toMatchObject({
      images: [
        {
          id: "dev",
          health: "healthy",
        },
        {
          id: "baseline",
          health: "unknown",
        },
      ],
    });
  });

  it("routes Pharo MCP calls to the selected running image", async () => {
    const imageRouter = new FakeImageRouter();
    const gateway = new PlexusGateway({
      imageRouter,
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: runningState,
        failures: [],
      }),
    });

    await gateway.handleTool("plexus_project_open", {
      projectPath: makeTempDir("plexus-project-"),
      workspaceId: "worktree-a",
    });
    const routed = data(
      await gateway.handleTool("plexus_route_to_image", {
        projectId: "project-123",
        workspaceId: "worktree-a",
        imageId: "dev",
        toolName: "pharo_eval",
        arguments: {
          code: "Smalltalk version",
        },
      }),
    );

    expect(imageRouter.calls).toEqual([
      {
        route: {
          projectId: "project-123",
          workspaceId: "worktree-a",
          targetId: "project-123--worktree-a",
          imageId: "dev",
          imageName: "MyProject-dev",
          port: 7123,
        },
        toolName: "pharo_eval",
        argumentsValue: {
          code: "Smalltalk version",
        },
      },
    ]);
    expect(routed).toMatchObject({
      route: {
        projectId: "project-123",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        imageId: "dev",
        port: 7123,
      },
      result: {
        content: [{ type: "text", text: "routed" }],
      },
    });
  });

  it("refuses to route to stopped images", async () => {
    const gateway = new PlexusGateway({
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: runningState,
        failures: [],
      }),
    });

    await gateway.handleTool("plexus_project_open", {
      projectPath: makeTempDir("plexus-project-"),
      workspaceId: "worktree-a",
    });

    expect(
      await gateway.handleTool("plexus_route_to_image", {
        projectId: "project-123",
        workspaceId: "worktree-a",
        imageId: "baseline",
        toolName: "pharo_eval",
      }),
    ).toMatchObject({
      ok: false,
      error: "Image baseline is not running; current status is stopped",
    });
  });

  it("closes a project and updates registered routes", async () => {
    const closedState: ProjectState = {
      ...runningState,
      updatedAt: "2026-04-25T11:00:00.000Z",
      images: runningState.images.map((image) => ({
        ...image,
        status: "stopped" as const,
      })),
    };
    const gateway = new PlexusGateway({
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: runningState,
        failures: [],
      }),
      projectClose: async (
        options: ProjectCloseOptions,
      ): Promise<ProjectCloseResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: closedState,
        stoppedImages: closedState.images,
        failures: [],
      }),
    });
    const projectRoot = makeTempDir("plexus-project-");

    await gateway.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      workspaceId: "worktree-a",
    });
    await gateway.handleTool("plexus_project_close", {
      projectPath: projectRoot,
      workspaceId: "worktree-a",
    });

    const status = data(
      await gateway.handleTool("plexus_project_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
      }),
    );

    expect(status).toMatchObject({
      images: [
        {
          id: "dev",
          status: "stopped",
        },
        {
          id: "baseline",
          status: "stopped",
        },
      ],
    });
  });

  it("hydrates status from runtime state when a project path is provided", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(stateRoot), runningState);
    const gateway = new PlexusGateway();

    const status = data(
      await gateway.handleTool("plexus_project_status", {
        projectPath: projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
      }),
    );

    expect(status).toMatchObject({
      projectId: "project-123",
      statePath: statePath(stateRoot),
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
    });
    expect(status.images[0]).toMatchObject({
      id: "dev",
      port: 7123,
      status: "running",
    });
  });

  it("keeps parallel worktree routes separate for the same project", async () => {
    const projectRootA = makeTempDir("plexus-project-a-");
    const projectRootB = makeTempDir("plexus-project-b-");
    const stateRoot = makeTempDir("plexus-state-");
    const stateA: ProjectState = {
      ...runningState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      images: [
        {
          id: "dev",
          imageName: "MyProject-worktree-a-dev",
          assignedPort: 7123,
          pid: 1234,
          status: "running",
        },
      ],
    };
    const stateB: ProjectState = {
      ...runningState,
      workspaceId: "worktree-b",
      targetId: "project-123--worktree-b",
      images: [
        {
          id: "dev",
          imageName: "MyProject-worktree-b-dev",
          assignedPort: 7125,
          pid: 5678,
          status: "running",
        },
      ],
    };
    const imageRouter = new FakeImageRouter();
    const gateway = new PlexusGateway({
      imageRouter,
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => {
        const workspaceId = options.workspaceId ?? "worktree-a";
        const state = workspaceId === "worktree-b" ? stateB : stateA;
        return {
          ok: true,
          projectRoot: path.resolve(options.projectRoot),
          statePath: statePath(stateRoot, workspaceId),
          state,
          failures: [],
        };
      },
    });

    await gateway.handleTool("plexus_project_open", {
      projectPath: projectRootA,
      stateRoot,
      workspaceId: "worktree-a",
    });
    await gateway.handleTool("plexus_project_open", {
      projectPath: projectRootB,
      stateRoot,
      workspaceId: "worktree-b",
    });

    const routes = data(
      await gateway.handleTool("plexus_project_status", {
        projectId: "project-123",
      }),
    );
    expect(Array.isArray(routes)).toBe(true);
    expect(routes).toMatchObject([
      {
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        images: [{ imageName: "MyProject-worktree-a-dev", port: 7123 }],
      },
      {
        workspaceId: "worktree-b",
        targetId: "project-123--worktree-b",
        images: [{ imageName: "MyProject-worktree-b-dev", port: 7125 }],
      },
    ]);

    await expect(
      gateway.handleTool("plexus_route_to_image", {
        projectId: "project-123",
        imageId: "dev",
        toolName: "pharo_eval",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "Multiple routes match; provide targetId or workspaceId",
    });

    expect(
      data(
        await gateway.handleTool("plexus_route_to_image", {
          projectId: "project-123",
          workspaceId: "worktree-b",
          imageId: "dev",
          toolName: "pharo_eval",
        }),
      ),
    ).toMatchObject({
      route: {
        projectId: "project-123",
        workspaceId: "worktree-b",
        targetId: "project-123--worktree-b",
        imageName: "MyProject-worktree-b-dev",
        port: 7125,
      },
    });
  });
});
